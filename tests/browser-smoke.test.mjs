import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtension } from '../tools/browser-runtime.mjs';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(root, 'dist/Echo_Translate');

test('隔离无头 Chrome：扩展实际加载、网页/设置/文档/媒体通过本地 mock API', { timeout: 240000 }, async t => {
  await readFile(path.join(extensionPath, 'manifest.json'));
  const calls = [];
  const asrCalls = [];
  const results = [];
  const screenshotDirectory = path.join(root, 'evidence/screenshots');
  await mkdir(screenshotDirectory, { recursive: true });
  const caseTest = async (name, callback) => t.test(name, async () => {
    const started = Date.now();
    try { await callback(); results.push({ name, status: 'pass', durationMs: Date.now() - started }); }
    catch (error) { results.push({ name, status: 'fail', durationMs: Date.now() - started, error: error.message }); throw error; }
  });
  const slowResponses = new Set();
  const fixture = `<!doctype html><html lang="en"><head><title>Echo browser fixture</title></head><body>
    <h1>Welcome to the independent translator.</h1>
    <p id="paragraph">Hello <a id="originalLink" href="#sample">world</a>. This paragraph must preserve its original link.</p>
    <p id="plain">Another visible paragraph for bilingual translation.</p>
    <p id="hidden" style="display:none">Hidden source must stay untouched.</p>
    <p id="invisible" style="visibility:hidden">Invisible source must stay untouched.</p>
    <pre id="code">const secretCode = 'leave code unchanged';</pre>
    <p id="excluded" translate="no">Excluded source must stay untouched.</p>
    <input id="editor" value="Write a short greeting." aria-label="editor"><input id="password" type="password" value="never translate">
  </body></html>`;
  const server = createServer(async (request, response) => {
    if (request.url === '/fixture') {
      response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); response.end(fixture); return;
    }
    if (request.url === '/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'mock-model' }] })); return;
    }
    if (request.method === 'POST' && request.url === '/audio/transcriptions') {
      let form = ''; for await (const part of request) form += part;
      asrCalls.push({ multipart: request.headers['content-type']?.startsWith('multipart/form-data'),
        hasFile: form.includes('filename="sample.wav"'), hasFormat: form.includes('srt'), hasModel: form.includes('mock-asr') });
      response.writeHead(200, { 'Content-Type': 'application/x-subrip;charset=utf-8' });
      response.end('1\n00:00:00,000 --> 00:00:01,000\nHello audio transcript.\n\n'); return;
    }
    if (request.method !== 'POST' || request.url !== '/chat/completions') { response.writeHead(404); response.end(); return; }
    let bytes = '';
    for await (const part of request) bytes += part;
    const body = JSON.parse(bytes);
    const items = JSON.parse(body.messages[1].content).items;
    calls.push({ items, system: body.messages[0].content, model: body.model });
    const send = () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify({ translations: items.map(item => ({ id: item.id, text: `译:${item.text}` })) }),
      } }] }));
    };
    if (items.some(item => /\[(?:slow|long)\]/.test(item.text))) {
      const timeout = setTimeout(send, items.some(item => item.text.includes('[long]')) ? 33000 : 15000); slowResponses.add(response);
      response.on('close', () => { clearTimeout(timeout); slowResponses.delete(response); });
    } else send();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let app;
  try {
    app = await launchExtension(extensionPath);
    const { context, worker, id } = app;
    context.setDefaultTimeout(10000);
    const browserErrors = [];
    context.on('page', page => page.on('pageerror', error => browserErrors.push(error.message)));
    await worker.evaluate(async baseUrl => {
      await chrome.storage.local.set({ settings: { baseUrl, model: 'mock-model', retries: 0 }, apiKey: 'local-mock-placeholder' });
    }, origin);
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/pages/options.html`);
    await options.waitForFunction(() => document.querySelector('[name=baseUrl]')?.value.startsWith('http://127.0.0.1:'));

    await caseTest('设置页、模型列表、公开配置无密钥、API 测试', async () => {
      const config = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings' }));
      assert.equal(config.ok, true); assert.equal(config.settings.hasKey, true);
      assert.equal('apiKey' in config.settings, false);
      assert.equal(JSON.stringify(config).includes('local-mock-placeholder'), false);
      await options.locator('#load-models').click();
      await options.waitForFunction(() => document.querySelector('#models option')?.value === 'mock-model');
      await options.locator('#test').click();
      await options.waitForFunction(() => document.querySelector('#status').textContent.includes('连接成功') || document.querySelector('#status').dataset.status === 'error');
      assert.match(await options.locator('#status').textContent(), /连接成功/);
      assert.equal(calls.at(-1).items[0].text, 'Hello, world.');
      assert.equal(calls.at(-1).model, 'mock-model');
      await options.screenshot({ path: path.join(screenshotDirectory, 'options.png'), fullPage: true,
        mask: [options.locator('#apiKey'), options.locator('#asrApiKey')] });
    });
    const page = await context.newPage();
    await page.goto(`${origin}/fixture`);
    await page.waitForSelector('#echo-translate-root', { state: 'attached' });
    const originals = await page.evaluate(() => {
      globalThis.fixtureLink = document.querySelector('#originalLink'); globalThis.linkClicks = 0;
      fixtureLink.addEventListener('click', event => { event.preventDefault(); globalThis.linkClicks++; });
      return Object.fromEntries(['paragraph', 'plain', 'hidden', 'invisible', 'code', 'excluded'].map(id => [id, document.getElementById(id).innerHTML]));
    });
    const tabId = await worker.evaluate(async fixtureUrl => (await chrome.tabs.query({})).find(tab => tab.url === fixtureUrl).id, `${origin}/fixture`);
    const sendTab = (type, extra = {}) => worker.evaluate(({ tabId, type, extra }) => chrome.tabs.sendMessage(tabId, { type, ...extra }), { tabId, type, extra });

    await caseTest('真实 content script：双语、隐藏与代码排除、动态段落、恢复原 DOM 与监听器', async () => {
      assert.equal((await sendTab('translate-page')).ok, true);
      await page.waitForSelector('#paragraph [data-echo-translation]');
      assert.match(await page.locator('#paragraph [data-echo-translation]').textContent(), /^译:Hello world/);
      assert.equal(await page.locator('#paragraph [data-echo-original]').count(), 0);
      assert.equal(await page.locator('#paragraph > #originalLink').count(), 1);
      for (const id of ['hidden', 'invisible', 'code', 'excluded']) {
        assert.equal(await page.locator(`#${id}`).innerHTML(), originals[id], `${id} 应排除翻译`);
      }
      await page.evaluate(() => {
        const node = document.createElement('p'); node.id = 'dynamic'; node.textContent = 'New paragraph added after translation.'; document.body.append(node);
      });
      await page.waitForSelector('#dynamic [data-echo-translation]');
      assert.equal(await page.locator('#dynamic [data-echo-translation]').textContent(), '译:New paragraph added after translation.');
      await page.evaluate(() => { document.querySelector('#plain').textContent = 'Updated source text after translation.'; });
      await page.waitForFunction(() => document.querySelector('#plain [data-echo-translation]')?.textContent === '译:Updated source text after translation.');
      originals.plain = 'Updated source text after translation.';
      await page.locator('#originalLink').click();
      assert.equal(await page.evaluate(() => fixtureLink === document.querySelector('#originalLink') && linkClicks === 1), true);
      assert.equal((await sendTab('restore-page')).ok, true);
      for (const id of Object.keys(originals)) assert.equal(await page.locator(`#${id}`).innerHTML(), originals[id]);
      assert.equal(await page.locator('[data-echo-translation]').count(), 0);
      await page.locator('#originalLink').click();
      assert.equal(await page.evaluate(() => fixtureLink === document.querySelector('#originalLink') && linkClicks === 2), true);
      const translated = calls.flatMap(call => call.items.map(item => item.text));
      for (const id of ['hidden', 'invisible', 'code', 'excluded']) {
        assert.equal(translated.includes(await page.locator(`#${id}`).textContent()), false, `${id} 不应发送至 API`);
      }
    });

    await sendTab('restore-page');
    await caseTest('选中解释与输入框翻译触发真实消息链', async () => {
      assert.equal((await sendTab('explain-selection', { text: 'Selected passage for explanation.' })).ok, true);
      assert.equal(await page.locator('#echo-translate-root').locator('.result').textContent(), '译:Selected passage for explanation.');
      assert.match(calls.at(-1).system, /Explain the selected text/);
      await page.locator('#editor').focus();
      await sendTab('translate-input');
      assert.equal(await page.locator('#editor').inputValue(), '译:Write a short greeting.');
      await page.locator('#password').focus(); await sendTab('translate-input');
      assert.equal(await page.locator('#password').inputValue(), 'never translate');
    });

    await caseTest('仅译文模式、侧栏翻译与请求取消', async () => {
      await worker.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...settings, displayMode: 'translation' } });
      });
      await sendTab('translate-page'); await page.waitForSelector('#paragraph [data-echo-translation]');
      assert.equal(await page.locator('#paragraph').getAttribute('data-echo-mode'), 'translation');
      assert.equal(await page.locator('#paragraph [data-echo-original]').isVisible(), false);
      await sendTab('restore-page');
      const panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/pages/panel.html`);
      await panel.locator('#text').fill('Panel translation sample.'); await panel.locator('#run').click();
      await panel.waitForFunction(() => document.querySelector('#output').textContent === '译:Panel translation sample.');
      await panel.locator('#text').fill('[slow] cancellation sample.'); await panel.locator('#run').click();
      await panel.waitForFunction(() => !document.querySelector('#cancel').disabled);
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const check = () => calls.some(call => call.items.some(item => item.text.includes('[slow]'))) ? resolve()
          : Date.now() > deadline ? reject(new Error('取消测试未观察到请求。')) : setTimeout(check, 20); check();
      });
      await panel.locator('#cancel').click();
      await panel.waitForFunction(() => document.querySelector('#status').textContent.includes('已取消'));
      assert.equal(await panel.locator('#run').isEnabled(), true);
      await panel.locator('#text').fill('[long] offscreen network lifecycle sample.'); await panel.locator('#run').click();
      await panel.waitForFunction(() => document.querySelector('#output').textContent === '译:[long] offscreen network lifecycle sample.', null, { timeout: 45000 });
    });

    const downloadBytes = async (documentPage, button) => {
      const [download] = await Promise.all([documentPage.waitForEvent('download'), documentPage.locator(button).click()]);
      const failure = await download.failure(); assert.equal(failure, null);
      return readFile(await download.path());
    };
    const documentPage = await context.newPage(); await documentPage.goto(`chrome-extension://${id}/pages/documents.html`);
    async function translateDocument(name, buffer, mimeType = 'application/octet-stream') {
      await documentPage.locator('#document-file').setInputFiles({ name, buffer: Buffer.from(buffer), mimeType });
      await documentPage.waitForFunction(() => document.querySelector('#document-status').textContent.startsWith('已读取')
        && !document.querySelector('#translate-document').disabled || document.querySelector('#document-error').textContent);
      assert.equal(await documentPage.locator('#document-error').textContent(), '', `${name} 导入失败`);
      assert.equal(await documentPage.locator('#translate-document').isEnabled(), true);
      await documentPage.locator('#translate-document').click();
      await documentPage.waitForFunction(() => document.querySelector('#document-status').textContent.startsWith('翻译完成') || document.querySelector('#document-error').textContent);
      assert.equal(await documentPage.locator('#document-error').textContent(), '', `${name} 翻译失败`);
      assert.match(await documentPage.locator('.document-translation').first().textContent(), /^译:/);
    }

    await caseTest('TXT、HTML、JSON 与字幕：导入、mock 翻译、双语导出和结构保留', async () => {
      await translateDocument('sample.txt', 'Hello document.\n\nSecond paragraph.\n', 'text/plain');
      assert.match((await downloadBytes(documentPage, '#export-document')).toString('utf8'), /Hello document\.\n译:Hello document\./);
      await translateDocument('sample.html', '<!doctype html><html><body><p>Hello <b>HTML</b> document.</p><script>globalThis.importedScriptExecuted = true</script><pre>do not translate code</pre></body></html>', 'text/html');
      assert.equal(await documentPage.evaluate(() => globalThis.importedScriptExecuted), undefined);
      const html = (await downloadBytes(documentPage, '#export-document')).toString('utf8');
      assert.match(html, /<b>HTML<span[^>]*>/); assert.match(html, /译:/); assert.match(html, /<pre>do not translate code<\/pre>/);
      await translateDocument('sample.json', JSON.stringify({ title: 'Hello JSON document.', url: 'https://example.com', count: 3 }), 'application/json');
      const json = JSON.parse((await downloadBytes(documentPage, '#export-document')).toString('utf8'));
      assert.match(json.title, /译:Hello JSON document\./); assert.equal(json.url, 'https://example.com'); assert.equal(json.count, 3);
      await translateDocument('sample.srt', '1\n00:00:01,000 --> 00:00:03,000\nHello subtitle.\n\n', 'text/plain');
      const srt = (await downloadBytes(documentPage, '#export-document')).toString('utf8');
      assert.match(srt, /00:00:01,000 --> 00:00:03,000/); assert.match(srt, /译:Hello subtitle\./);
    });

    await caseTest('DOCX 与 EPUB：本地 ZIP vendor、正文翻译导出及未改附件保留', async () => {
      const style = '<styles>keep-original-style</styles>';
      const docx = zipSync({
        '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
        '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
        'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello DOCX document.</w:t></w:r></w:p></w:body></w:document>'),
        'word/styles.xml': strToU8(style),
      });
      await translateDocument('sample.docx', docx);
      const docxResult = unzipSync(await downloadBytes(documentPage, '#export-document'));
      assert.match(strFromU8(docxResult['word/document.xml']), /译:Hello DOCX document\./);
      assert.equal(strFromU8(docxResult['word/styles.xml']), style);
      const epub = zipSync({
        mimetype: [strToU8('application/epub+zip'), { level: 0 }],
        'META-INF/container.xml': strToU8('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
        'OEBPS/content.opf': strToU8('<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'),
        'OEBPS/chapter.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Sample</title></head><body><p>Hello EPUB chapter.</p></body></html>'),
        'OEBPS/keep.css': strToU8('p { color: black; }'),
      });
      await translateDocument('sample.epub', epub);
      const epubBytes = await downloadBytes(documentPage, '#export-document');
      const epubResult = unzipSync(epubBytes);
      assert.match(strFromU8(epubResult['OEBPS/chapter.xhtml']), /译:Hello EPUB chapter\./);
      assert.equal(strFromU8(epubResult['OEBPS/keep.css']), 'p { color: black; }');
      assert.equal(epubBytes.subarray(30, 38).toString(), 'mimetype'); assert.equal(epubBytes.readUInt16LE(8), 0);
    });

    await caseTest('PDF：实际本地 worker 提取、canvas 预览、中文字体与双语 PDF 导出', async () => {
      const source = await PDFDocument.create(); const font = await source.embedFont(StandardFonts.Helvetica);
      source.addPage([420, 594]).drawText('Hello PDF document.', { x: 40, y: 530, font, size: 16 });
      await translateDocument('sample.pdf', await source.save(), 'application/pdf');
      assert.equal(await documentPage.locator('#pdf-original-panel').isVisible(), true);
      assert.ok(await documentPage.locator('#pdf-page-canvas').evaluate(canvas => canvas.width > 0 && canvas.height > 0));
      await documentPage.locator('#pdf-font-file').setInputFiles(process.env.ECHO_TEST_FONT || 'C:/Windows/Fonts/simhei.ttf');
      await documentPage.waitForFunction(() => document.querySelector('#pdf-font-status').textContent.startsWith('已载入字体'));
      const output = await downloadBytes(documentPage, '#export-document');
      assert.equal((await PDFDocument.load(output)).getPageCount(), 2);
      assert.equal(await documentPage.locator('#document-error').textContent(), '');
      await documentPage.screenshot({ path: path.join(screenshotDirectory, 'documents.png'), fullPage: true });
    });

    await caseTest('图片：本地组件加载、编辑文字框、mock 翻译、PNG/TXT 导出', async () => {
      const media = await context.newPage(); await media.goto(`chrome-extension://${id}/pages/media.html`);
      await media.waitForFunction(() => !!globalThis.Tesseract?.createWorker);
      const imageBytes = await media.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 180;
        const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 900, 180);
        context.fillStyle = '#000'; context.font = '48px Arial'; context.fillText('HELLO ECHO TRANSLATE', 40, 100);
        return canvas.toDataURL('image/png').split(',')[1];
      });
      await media.locator('#image-file').setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: Buffer.from(imageBytes, 'base64') });
      await media.waitForFunction(() => !document.querySelector('#add-box').disabled);
      await media.locator('#add-box').click(); await media.locator('#block-source').fill('Hello image translation.');
      await media.locator('#translate').click();
      await media.waitForFunction(() => document.querySelector('#block-translation').value === '译:Hello image translation.');
      const text = (await downloadBytes(media, '#export-txt')).toString('utf8'); assert.match(text, /译:Hello image translation\./);
      const png = await downloadBytes(media, '#export-png'); assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(png.readUInt32BE(16), 900); assert.equal(png.readUInt32BE(20), 180);
      await media.screenshot({ path: path.join(screenshotDirectory, 'media.png'), fullPage: true });
      await media.close();
    });

    await caseTest('独立 ASR：multipart mock 转写、字幕翻译、SRT/VTT 导出', async () => {
      await worker.evaluate(async baseUrl => {
        const { settings } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...settings, asrBaseUrl: baseUrl, asrModel: 'mock-asr' }, asrApiKey: 'local-asr-mock-placeholder' });
      }, origin);
      const audio = await context.newPage(); await audio.goto(`chrome-extension://${id}/pages/audio.html`);
      const wav = Buffer.alloc(44 + 32000);
      wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
      wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
      await audio.locator('#audio-file').setInputFiles({ name: 'sample.wav', mimeType: 'audio/wav', buffer: wav });
      await audio.locator('#audio-transcribe').click();
      await audio.waitForFunction(() => document.querySelector('#audio-status').textContent.startsWith('转写完成') || document.querySelector('#audio-status').classList.contains('error'));
      assert.match(await audio.locator('#audio-status').textContent(), /转写完成/);
      assert.deepEqual(asrCalls, [{ multipart: true, hasFile: true, hasFormat: true, hasModel: true }]);
      await audio.locator('#audio-translate').click();
      await audio.waitForFunction(() => document.querySelector('#audio-status').textContent.startsWith('翻译完成'));
      assert.match(await audio.locator('#audio-preview').inputValue(), /译:Hello audio transcript\./);
      const srt = (await downloadBytes(audio, '#audio-export-srt')).toString('utf8'); assert.match(srt, /00:00:00,000 --> 00:00:01,000/);
      const vtt = (await downloadBytes(audio, '#audio-export-vtt')).toString('utf8'); assert.match(vtt, /^WEBVTT/); assert.match(vtt, /译:Hello audio transcript\./);
      await audio.close();
    });

    await caseTest('实时音频：真实 MediaRecorder 合成音源、finish/abort、mock 直播字幕链与网页叠加', async () => {
      const live = await context.newPage(); await live.goto(`chrome-extension://${id}/pages/audio.html`);
      await live.locator('#live-refresh-tabs').click();
      const recordings = await live.evaluate(async () => {
        const { recordSegment } = await import('../src/live-audio.js');
        const audio = new AudioContext();
        const oscillator = audio.createOscillator(); const destination = audio.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start(); await audio.resume();
        try {
          const file = await recordSegment(destination.stream, 150, new AbortController().signal);
          const short = recordSegment(destination.stream, 5000, new AbortController().signal);
          setTimeout(() => short.finish(), 150); const finished = await short;
          const controller = new AbortController(); const cancelled = recordSegment(destination.stream, 5000, controller.signal);
          setTimeout(() => controller.abort(new DOMException('合成录制取消', 'AbortError')), 40);
          let cancelName; try { await cancelled; } catch (error) { cancelName = error.name; }
          return { size: file.size, mime: file.type, signature: [...new Uint8Array(await file.slice(0, 4).arrayBuffer())],
            finishedSize: finished.size, cancelName };
        } finally { oscillator.stop(); destination.stream.getTracks().forEach(track => track.stop()); await audio.close(); }
      });
      assert.ok(recordings.size > 0); assert.match(recordings.mime, /^audio\/webm/);
      assert.deepEqual(recordings.signature, [0x1a, 0x45, 0xdf, 0xa3]); assert.ok(recordings.finishedSize > 0); assert.equal(recordings.cancelName, 'AbortError');
      await live.evaluate(async () => {
        const audio = new AudioContext(); const oscillator = audio.createOscillator();
        const destination = audio.createMediaStreamDestination(); oscillator.connect(destination); oscillator.start(); await audio.resume();
        globalThis.syntheticCapture = { audio, oscillator, stream: destination.stream };
        Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true,
          value: async () => destination.stream });
      });
      try {
        await live.locator('#live-tab').selectOption(String(tabId)); await live.locator('#live-start').click();
        await live.waitForFunction(() => !document.querySelector('#live-stop').disabled);
        await live.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
        await live.locator('#live-stop').click();
        await live.waitForFunction(() => document.querySelector('#live-status').textContent.startsWith('已完成')
          || document.querySelector('#live-status').textContent.startsWith('实时字幕停止'));
        assert.match(await live.locator('#live-status').textContent(), /已完成 1 条字幕/);
        assert.match(await live.locator('#live-transcript').inputValue(), /译:Hello audio transcript\./);
        await page.waitForFunction(() => [...document.querySelector('#echo-translate-root').shadowRoot.children]
          .some(element => element.style.pointerEvents === 'none' && element.textContent.includes('译:Hello audio transcript.') && !element.hidden));
        const subtitles = (await downloadBytes(live, '#live-export')).toString('utf8');
        assert.match(subtitles, /--> /); assert.match(subtitles, /译:Hello audio transcript\./);
        await sendTab('live-caption', { text: '' });
        assert.equal(await page.evaluate(() => [...document.querySelector('#echo-translate-root').shadowRoot.children]
          .find(element => element.style.pointerEvents === 'none').hidden), true);
      } finally {
        await live.evaluate(async () => {
          syntheticCapture.oscillator.stop(); syntheticCapture.stream.getTracks().forEach(track => track.stop()); await syntheticCapture.audio.close();
        });
        await live.close();
      }
    });
    await writeFile(path.join(root, 'evidence/browser-validation.json'), JSON.stringify({
      executedAt: new Date().toISOString(), browser: context.browser().version(), headless: true,
      isolatedTemporaryProfile: true, actualUserProfileUsed: false,
      api: { realDeepSeekCalled: false, translationMockRequests: calls.length, asrMockRequests: asrCalls.length },
      longRequest: { configuredMockDelayMs: 33000, verified: results.find(item => item.name.startsWith('仅译文模式'))?.status === 'pass' },
      liveAudio: { actualMediaRecorder: true, input: 'AudioContext 人工合成音轨', nativeGetDisplayMediaCalled: false,
        systemAudioOrMicrophoneCaptured: false, asrAndTranslation: '本地 mock',
        verified: results.find(item => item.name.startsWith('实时音频'))?.status === 'pass' },
      screenshots: ['options.png', 'documents.png', 'media.png'].map(file => `evidence/screenshots/${file}`),
      results, pageErrors: browserErrors,
      notCovered: ['真实 DeepSeek API 与计费', '真实第三方 ASR 服务', '真实系统音源选择器、会议平台或直播音轨采集', '真实 YouTube/各站点专用适配', '大型复杂文档与精准 PDF 版式重排', '各 OCR 语言、手写体与复杂漫画'],
    }, null, 2));
    assert.deepEqual(browserErrors, [], `扩展页面存在运行时错误：${browserErrors.join('; ')}`);
    console.log(`本地 mock 端到端执行结束；真实 DeepSeek API 未调用。共 ${calls.length} 次 mock 模型请求；通过状态见测试计数。`);
  } finally {
    await app?.close();
    for (const response of slowResponses) response.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
