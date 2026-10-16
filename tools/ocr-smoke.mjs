import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchExtension } from './browser-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
console.log('OCR 实测将从 tessdata.projectnaptha.com 下载公开英语语言数据；不调用翻译 API。');
const app = await launchExtension(path.join(root, 'dist/Echo_Translate'));
try {
  const media = await app.context.newPage();
  await media.goto(`chrome-extension://${app.id}/pages/media.html`);
  await media.waitForFunction(() => !!globalThis.Tesseract?.createWorker);
  const image = await media.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 220;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 1000, 220);
    context.fillStyle = '#000'; context.font = '60px Arial'; context.fillText('HELLO ECHO TRANSLATE', 40, 130);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await media.locator('#image-file').setInputFiles({ name: 'ocr-smoke.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
  await media.waitForFunction(() => !document.querySelector('#recognize').disabled);
  await media.locator('#recognize').click();
  await media.waitForFunction(() => /^识别到/.test(document.querySelector('#media-status').textContent)
    || document.querySelector('#media-status').classList.contains('error'), null, { timeout: 90000 });
  const status = await media.locator('#media-status').textContent();
  assert.match(status, /^识别到/, `OCR 运行失败：${status}`);
  const recognized = await media.locator('#block-source').inputValue();
  assert.match(recognized.toUpperCase(), /HELLO ECHO TRANSLATE/);
  await mkdir(path.join(root, 'evidence/screenshots'), { recursive: true });
  await media.screenshot({ path: path.join(root, 'evidence/screenshots/media-ocr.png'), fullPage: true });
  await writeFile(path.join(root, 'evidence/ocr-validation.json'), JSON.stringify({
    executedAt: new Date().toISOString(), status: 'pass', browser: app.context.browser().version(),
    localWorkerAndWasm: true, language: 'eng', externalLanguageDataUrl: 'https://tessdata.projectnaptha.com/4.0.0',
    translationApiCalled: false, recognizedText: recognized.trim(), result: status,
    screenshot: 'evidence/screenshots/media-ocr.png',
    notCovered: ['其他OCR语言', '复杂漫画、竖排、手写体', '离线语言数据导入'],
  }, null, 2));
  console.log(`本地 Tesseract worker / WASM / 英语 OCR 通过：${status}`);
  console.log(`测试图片识别文本：${recognized.trim()}`);
} finally { await app.close(); }
