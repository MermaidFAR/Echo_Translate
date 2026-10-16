import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
let jsCount = 0;
let htmlCount = 0;

async function exists(file) {
  return stat(file).then(() => true, () => false);
}

async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'evidence'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(file));
    else found.push(file);
  }
  return found;
}

function localReference(reference, source) {
  if (/^(https?:|data:|javascript:)/i.test(reference)) return errors.push(`${source} 引用了远程或内联资源：${reference.slice(0, 80)}`);
  const normalized = reference.replace(/[?#].*$/, '');
  const target = reference.startsWith('/') ? path.join(root, normalized.slice(1)) : path.resolve(path.dirname(source), normalized);
  if (!target.startsWith(`${root}${path.sep}`)) errors.push(`${source} 引用超出工程：${reference}`);
  return target;
}

for (const file of await walk(root)) {
  if (/\.(?:js|mjs)$/.test(file)) {
    jsCount++;
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) errors.push(result.stderr.trim());
    const code = await readFile(file, 'utf8');
    if (!file.includes(`${path.sep}tests${path.sep}`) && /\b(?:eval|new\s+Function)\s*\(/.test(code)) errors.push(`${file} 含运行时动态代码执行。`);
    if (/import\s*(?:\(|[^;]*?from\s*)['"]https?:/i.test(code)) errors.push(`${file} 含远程 JavaScript 导入。`);
    for (const match of code.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      const built = path.join(root, 'dist/Echo_Translate', path.relative(root, target));
      if (!(await exists(target)) && !(target.includes(`${path.sep}vendor${path.sep}`) && await exists(built))) {
        errors.push(`${file} 缺少本地导入：${match[1]}（vendor 请先运行构建）。`);
      }
    }
  }
  if (file.endsWith('.html')) {
    htmlCount++;
    const html = await readFile(file, 'utf8');
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const source = /\bsrc\s*=\s*['"]([^'"]+)['"]/i.exec(match[1]);
      if (!source) errors.push(`${file} 含内联脚本。`);
      else {
        const target = localReference(source[1], file);
        if (target && !(await exists(target)) && !source[1].includes('vendor/')) errors.push(`${file} 缺少脚本：${source[1]}`);
      }
    }
    if (/\son[a-z]+\s*=\s*['"]/i.test(html)) errors.push(`${file} 含内联事件处理器。`);
    for (const match of html.matchAll(/<link\b[^>]*\bhref\s*=\s*['"]([^'"]+)['"]/gi)) {
      const target = localReference(match[1], file);
      if (target && !(await exists(target))) errors.push(`${file} 缺少样式：${match[1]}`);
    }
  }
}

const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) errors.push('manifest_version 必须为 3。');
if (manifest.background?.type !== 'module') errors.push('Service worker 必须使用 module。');
const files = [manifest.background?.service_worker, manifest.options_page, manifest.action?.default_popup, manifest.side_panel?.default_path];
for (const content of manifest.content_scripts ?? []) files.push(...(content.js ?? []), ...(content.css ?? []));
for (const entry of Object.values(manifest.icons ?? {})) files.push(entry);
for (const file of files.filter(Boolean)) if (!(await exists(path.join(root, file)))) errors.push(`manifest 引用文件不存在：${file}`);
for (const item of manifest.web_accessible_resources ?? []) for (const file of item.resources ?? []) {
  if (!file.includes('*') && !(await exists(path.join(root, file)))) errors.push(`web_accessible_resources 引用文件不存在：${file}`);
}
const csp = manifest.content_security_policy?.extension_pages ?? '';
if (/https?:/.test(csp)) errors.push('扩展 CSP 含远程执行来源。');
if (/(?:^|\s)'unsafe-eval'(?=\s|;|$)/.test(csp)) errors.push('扩展 CSP 不应启用 unsafe-eval。');
if (/worker-src[^;]*\bblob:/.test(csp)) errors.push('MV3 扩展 worker-src 不接受 blob:。');
if (!csp.includes("script-src 'self'")) errors.push('扩展 CSP 必须限制 script-src 为 self。');

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log(`静态检查通过：${jsCount} 个 JavaScript 文件、${htmlCount} 个 HTML 页面及 Manifest 引用。`);
