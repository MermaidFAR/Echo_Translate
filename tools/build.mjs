import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const output = path.join(dist, 'Echo_Translate');

async function exists(file) {
  return stat(file).then(() => true, () => false);
}

async function bundle(contents, outfile) {
  await build({
    stdin: { contents, resolveDir: root },
    outfile: path.join(output, outfile),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome120'],
    legalComments: 'linked',
    minify: true,
    logLevel: 'warning',
  });
}

async function copyRelative(from, to = from) {
  const source = path.join(root, from);
  if (!(await exists(source))) throw new Error(`构建缺少文件：${from}`);
  await cp(source, path.join(output, to), { recursive: true });
}

async function copyLicenses() {
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const notices = [
    'Echo Translate 第三方组件许可',
    '本扩展为独立实现，未包含沉浸式翻译的主体代码、品牌或资产。',
    '以下清单由 package-lock.json 的固定生产依赖生成；完整许可见 LICENSES/。',
    '',
  ];
  await mkdir(path.join(output, 'LICENSES'), { recursive: true });
  for (const [location, item] of Object.entries(lock.packages ?? {})) {
    if (!location || item.dev) continue;
    const moduleDir = path.join(root, location);
    if (!(await exists(moduleDir))) continue;
    const metadata = JSON.parse(await readFile(path.join(moduleDir, 'package.json'), 'utf8'));
    const name = metadata.name ?? location;
    const licenseFiles = (await readdir(moduleDir)).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
    const prefix = `${name.replaceAll('/', '_').replaceAll('@', '')}-${metadata.version}`;
    const saved = [];
    for (const license of licenseFiles) {
      const licensePath = path.join(moduleDir, license);
      if (!(await stat(licensePath)).isFile()) continue;
      const filename = `${prefix}-${license}`;
      await cp(licensePath, path.join(output, 'LICENSES', filename));
      saved.push(`LICENSES/${filename}`);
    }
    notices.push(`${name}@${metadata.version} — ${metadata.license ?? item.license ?? '参见组件许可'}`);
    if (metadata.homepage) notices.push(`  ${metadata.homepage}`);
    notices.push(`  ${saved.length ? saved.join(', ') : '包未提供单独许可文件；请查阅其包元数据。'}`);
  }
  const text = `${notices.join('\n')}\n`;
  await writeFile(path.join(root, 'THIRD_PARTY_NOTICES.txt'), text);
  await writeFile(path.join(output, 'THIRD_PARTY_NOTICES.txt'), text);
}

async function zipDirectory(directory, prefix = '') {
  const entries = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(entries, await zipDirectory(file, `${name}/`));
    else if (entry.isFile()) entries[name] = new Uint8Array(await readFile(file));
  }
  return entries;
}

async function createSourceArchive() {
  const files = {};
  for (const name of ['manifest.json', 'package.json', 'package-lock.json', 'src', 'pages', 'tools', 'tests', 'assets',
    'README.md', 'REA_Report.md', 'AGENTS.md', '.github', '.gitignore', 'THIRD_PARTY_NOTICES.txt', 'LICENSE']) {
    const entry = path.join(root, name);
    if (!(await exists(entry))) continue;
    if ((await stat(entry)).isDirectory()) Object.assign(files, await zipDirectory(entry, `${name}/`));
    else files[name] = new Uint8Array(await readFile(entry));
  }
  const evidence = path.join(root, 'evidence');
  if (await exists(evidence)) for (const name of await readdir(evidence)) {
    const file = path.join(evidence, name);
    if (/\.(json|mjs)$/.test(name) && (await stat(file)).isFile()) files[`evidence/${name}`] = new Uint8Array(await readFile(file));
  }
  await mkdir(dist, { recursive: true });
  const archive = zipSync(files, { level: 9 });
  const file = path.join(dist, 'Echo_Translate_Source.zip');
  await writeFile(file, archive);
  console.log(`源码压缩包：${file}（${(archive.length / 1024).toFixed(1)} KiB，${Object.keys(files).length} 个文件）`);
  const checksums = [];
  for (const name of ['Echo_Translate.zip', 'Echo_Translate_Source.zip']) {
    const artifact = path.join(dist, name);
    if (await exists(artifact)) checksums.push(`${createHash('sha256').update(await readFile(artifact)).digest('hex')}  ${name}`);
  }
  await writeFile(path.join(dist, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
}

if (process.argv.includes('--source-only')) {
  await createSourceArchive();
  process.exit(0);
}

if (path.dirname(output) !== dist || path.dirname(dist) !== root) throw new Error('构建输出路径超出工程边界。');
await mkdir(dist, { recursive: true });
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'vendor'), { recursive: true });
for (const file of ['manifest.json', 'src', 'pages']) await copyRelative(file);
for (const file of ['assets', 'README.md', 'LICENSE']) if (await exists(path.join(root, file))) await copyRelative(file);

await bundle("export * from 'fflate';", 'vendor/fflate.js');
await bundle("export * from 'pdf-lib';", 'vendor/pdf-lib.js');
await bundle("import fontkit from '@pdf-lib/fontkit'; export default fontkit;", 'vendor/fontkit.js');
await copyRelative('node_modules/pdfjs-dist/build/pdf.mjs', 'vendor/pdf.mjs');
await copyRelative('node_modules/pdfjs-dist/build/pdf.worker.mjs', 'vendor/pdf.worker.mjs');
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
  await copyRelative(`node_modules/pdfjs-dist/${folder}`, `vendor/pdfjs/${folder}`);
}
await copyRelative('node_modules/tesseract.js/dist/tesseract.min.js', 'vendor/tesseract/tesseract.min.js');
await copyRelative('node_modules/tesseract.js/dist/worker.min.js', 'vendor/tesseract/worker.min.js');
const coreSource = path.join(root, 'node_modules/tesseract.js-core');
await mkdir(path.join(output, 'vendor/tesseract/core'), { recursive: true });
for (const filename of await readdir(coreSource)) {
  if (/\.(wasm|wasm\.js)$/.test(filename)) {
    await cp(path.join(coreSource, filename), path.join(output, 'vendor/tesseract/core', filename));
  }
}
await copyLicenses();
const files = await zipDirectory(output);
const archive = zipSync(files, { level: 6 });
const archivePath = path.join(dist, 'Echo_Translate.zip');
await writeFile(archivePath, archive);
console.log(`可加载扩展：${output}`);
console.log(`安装压缩包：${archivePath}（${(archive.length / 1024 / 1024).toFixed(1)} MiB，${Object.keys(files).length} 个文件）`);
await createSourceArchive();
