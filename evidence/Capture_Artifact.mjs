import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const input = process.argv[2];
if (!input || !path.isAbsolute(input)) throw new Error('请传入扩展安装包目录的绝对路径；不要传浏览器用户数据根目录。');
const manifest = JSON.parse(await readFile(path.join(input, 'manifest.json'), 'utf8'));
const config = JSON.parse(await readFile(path.join(input, 'default_config.json'), 'utf8'));
const selectedFiles = ['manifest.json', 'background.js', 'content_guard.js', 'content_main.js', 'options.js', 'popup.js',
  'offscreen.js', 'side-panel.js', 'default_config.json', 'default_config.content.json', 'pdf/index.html', 'pdf/extension-entry.js'];
const files = [];
for (const file of selectedFiles) {
  const bytes = await readFile(path.join(input, file));
  files.push({ path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const snippets = [];
for (const [file, seeds] of [['pdf/index.html', ['app.immersivetranslate.com/pdf']],
  ['pdf/extension-entry.js', ['postMessage']], ['options.js', ['serviceKey:"deepseek"', 'services.consent.supportFeatures']],
  ['content_main.js', ['APIKEY is encrypted', 'u.headers.Authorization="Bearer "+c']]]) {
  const text = await readFile(path.join(input, file), 'utf8');
  for (const seed of seeds) {
    const offset = text.indexOf(seed);
    snippets.push({ path: file, seed, offset, line: offset < 0 ? null : text.slice(0, offset).split('\n').length,
      snippet: offset < 0 ? null : text.slice(Math.max(0, offset - 100), offset + seed.length + 200) });
  }
}
const service = config.translationServices.deepseek;
const result = {
  capturedAt: new Date().toISOString(), input, manifest: { name: manifest.name, version: manifest.version,
    manifest_version: manifest.manifest_version, background: manifest.background, permissions: manifest.permissions,
    options_page: manifest.options_page },
  deepseek: Object.fromEntries(['provider', 'apiUrl', 'model', 'models', 'supportFeatures', 'modelsOverrides'].map(key => [key, service[key]])),
  files, snippets,
  scope: '仅静态安装包。没有读取浏览器配置数据库、API Key、Cookie、账号状态；没有运行原扩展。',
};
const output = path.join(path.dirname(fileURLToPath(import.meta.url)), 'artifact-observations.json');
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(`已保存 ${files.length} 个文件指纹与 ${snippets.length} 处有界证据：${output}`);
