import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
const browser = await readJson('evidence/browser-validation.json');
const ocr = await readJson('evidence/ocr-validation.json');
const readingLayout = await readJson('evidence/reading-layout-validation.json');
const audit = await readJson('evidence/dependency-audit.json');
const output = await readFile(path.join(root, 'evidence/test-output.txt'), 'utf8');
const checks = await readFile(path.join(root, 'evidence/check-output.txt'), 'utf8');
const field = name => Number([...output.matchAll(new RegExp(`^# ${name} (\\d+(?:\\.\\d+)?)`, 'gm'))].at(-1)?.[1] ?? NaN);
const testResults = { command: 'npm test', tests: field('tests'), passed: field('pass'), failed: field('fail'),
  skipped: field('skipped'), durationMs: field('duration_ms'), output: 'evidence/test-output.txt' };
if (!Number.isFinite(testResults.tests)) throw new Error('未找到最终 npm test TAP 计数。');
const staticStatus = checks.includes('静态检查通过');
const archivePath = path.join(root, 'dist/Echo_Translate.zip');
const archive = await readFile(archivePath);
const artifact = { path: 'dist/Echo_Translate.zip', bytes: archive.length,
  sha256: createHash('sha256').update(archive).digest('hex'), builtAt: (await stat(archivePath)).mtime.toISOString() };
const mismatches = [];
async function compare(file) {
  if ((await stat(path.join(root, file))).isDirectory()) {
    for (const name of await readdir(path.join(root, file))) await compare(`${file}/${name}`);
    return;
  }
  const original = await readFile(path.join(root, file));
  const copied = await readFile(path.join(root, 'dist/Echo_Translate', file)).catch(() => null);
  if (!copied || !original.equals(copied)) mismatches.push(file);
}
for (const name of ['src', 'pages', 'manifest.json', 'README.md']) await compare(name);
const allPassed = testResults.failed === 0 && testResults.tests === testResults.passed && staticStatus
  && browser.results.every(item => item.status === 'pass') && browser.pageErrors.length === 0 && ocr.status === 'pass'
  && readingLayout.status === 'pass' && !mismatches.length;
const validation = {
  generatedAt: new Date().toISOString(), timezone: 'Asia/Shanghai', status: allPassed ? 'pass' : 'fail',
  artifact, sourceArchive: 'dist/Echo_Translate_Source.zip',
  sourceMatchesBuiltExtension: { status: mismatches.length ? 'fail' : 'pass', mismatches },
  tests: testResults, staticChecks: { command: 'npm run check', status: staticStatus ? 'pass' : 'fail', output: 'evidence/check-output.txt' },
  dependencyAudit: { command: 'npm audit --omit=dev --json', vulnerabilities: audit.metadata.vulnerabilities, output: 'evidence/dependency-audit.json' },
  browser, ocr, readingLayout,
  boundaries: { realDeepSeekApiCalled: false, realAsrApiCalled: false, paidModelUsage: false,
    userBrowserProfileAccessed: false, externalPublicDownload: 'OCR 英语语言数据（tessdata.projectnaptha.com）',
    localTestFont: `${process.env.ECHO_TEST_FONT || 'C:/Windows/Fonts/simhei.ttf'}，仅用于测试，不随成品打包` },
};
await writeFile(path.join(root, 'evidence/validation.json'), `${JSON.stringify(validation, null, 2)}\n`);
console.log(`最终验证记录：evidence/validation.json（${validation.status}，${testResults.passed}/${testResults.tests} tests）`);
console.log(`扩展 SHA-256：${artifact.sha256}`);
if (!allPassed) process.exitCode = 1;
