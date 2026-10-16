import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { detectFormat, isTranslatable, applyTextEdits, parseParagraphs, parseSubtitles, exportRangeDocument, parseJsonDocument, exportJsonDocument, splitLongText, escapeXml, validateZipEntry, parseMarkup, exportMarkup } from '../src/file-formats.js';

test('格式识别与文本过滤', () => {
  assert.equal(detectFormat('测试.DOCX'), 'docx');
  assert.equal(detectFormat('字幕.ssa'), 'ass');
  assert.throws(() => detectFormat('program.exe'), /不支持/);
  assert.equal(isTranslatable('https://example.com/hello'), false);
  assert.equal(isTranslatable('1234 %%'), false);
  assert.equal(isTranslatable('你好 world'), true);
  assert.equal(escapeXml('<b> & "x"'), '&lt;b&gt; &amp; &quot;x&quot;');
});

test('区间导出保留分隔和验证重叠', () => {
  assert.equal(applyTextEdits('abcdef', [{ start: 1, end: 3, text: '中文' }]), 'a中文def');
  assert.throws(() => applyTextEdits('abcdef', [{ start: 1, end: 4, text: '' }, { start: 2, end: 3, text: '' }]), /重叠/);
  const text = 'Hello world\r\n\r\nNext paragraph\r\n';
  const segments = parseParagraphs(text);
  assert.equal(exportRangeDocument(text, segments, ['你好', '下一段']), 'Hello world\r\n你好\r\n\r\nNext paragraph\r\n下一段\r\n');
});

test('Markdown 不翻译代码围栏与缩进代码', () => {
  const text = '# Heading\n\n```js\nconst title = "Do not translate";\n```\n\n    indented code\n\nNormal paragraph';
  const segments = parseParagraphs(text, true);
  assert.deepEqual(segments.map(segment => segment.source), ['# Heading', 'Normal paragraph']);
  const exported = exportRangeDocument(text, segments, ['# 标题', '普通段落'], 'translated', 'md');
  assert.match(exported, /const title = "Do not translate"/);
  assert.match(exported, /    indented code/);
});

test('SRT 保留序号时间轴及换行格式', () => {
  const text = '1\r\n00:00:01,000 --> 00:00:02,100\r\nHello\r\nworld\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nSecond\r\n';
  const segments = parseSubtitles(text, 'srt');
  assert.deepEqual(segments.map(segment => segment.source), ['Hello\nworld', 'Second']);
  const output = exportRangeDocument(text, segments, ['你好\n世界', '第二段'], 'bilingual', 'srt');
  assert.match(output, /00:00:01,000 --> 00:00:02,100\r\nHello\r\nworld\r\n你好\r\n世界/);
  assert.equal(parseSubtitles(output, 'srt').length, 2);
});

test('WebVTT 不改 WEBVTT、NOTE、STYLE 和 cue 标识', () => {
  const text = 'WEBVTT\n\nNOTE private note\nDo not translate\n\nSTYLE\n::cue { color: red; }\n\ncue-1\n00:01.000 --> 00:03.000 align:start\nHello <b>world</b>\n';
  const segments = parseSubtitles(text, 'vtt');
  assert.deepEqual(segments.map(segment => segment.source), ['Hello <b>world</b>']);
  const output = exportRangeDocument(text, segments, ['你好 <b>世界</b>'], 'translated', 'vtt');
  assert.match(output, /NOTE private note\nDo not translate/);
  assert.match(output, /cue-1\n00:01.000 --> 00:03.000 align:start\n你好/);
});

test('LRC 多时间标签双语重复时间轴，保留元数据', () => {
  const text = '[ar:Artist]\n[00:01.20][00:05.20]Hello, world\n';
  const segments = parseSubtitles(text, 'lrc');
  assert.equal(segments.length, 1);
  assert.equal(exportRangeDocument(text, segments, ['你好，世界'], 'bilingual', 'lrc'), '[ar:Artist]\n[00:01.20][00:05.20]Hello, world\n[00:01.20][00:05.20]你好，世界\n');
});

test('ASS 保留事件字段、逗号与开头样式标签', () => {
  const text = '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Hello, world\\NSecond line\n';
  const segments = parseSubtitles(text, 'ass');
  assert.equal(segments[0].source, 'Hello, world\nSecond line');
  assert.match(exportRangeDocument(text, segments, ['你好，世界\n第二行'], 'translated', 'ass'), /,,\{\\i1\}你好，世界\\N第二行/);
  assert.match(exportRangeDocument(text, segments, ['你好'], 'bilingual', 'ass'), /Hello, world\\NSecond line\\N你好/);
  assert.throws(() => parseSubtitles('[Events]\nFormat: Text, Start\nDialogue: Hello,0:00:01.00', 'ass'), /最后一列/);
});

test('JSON 只替换字符串值，保留数据形状和危险属性名', () => {
  const { value, segments } = parseJsonDocument('{"title":"Hello","nested":[42,"World",false],"url":"https://example.com","__proto__":"Text"}');
  assert.deepEqual(segments.map(segment => segment.source), ['Hello', 'World', 'Text']);
  const result = JSON.parse(exportJsonDocument(value, segments, ['你好', '世界', '内容'], 'translated'));
  assert.equal(result.title, '你好');
  assert.deepEqual(result.nested, [42, '世界', false]);
  assert.equal(result.url, 'https://example.com');
  assert.equal(Object.getOwnPropertyDescriptor(result, '__proto__').value, '内容');
  assert.equal(JSON.parse(exportJsonDocument('Hello', [{ source: 'Hello', path: [] }], ['你好'])), 'Hello\n你好');
  assert.throws(() => parseJsonDocument('{broken'), /解析失败/);
});

test('长文本分块可无损还原并不切断代理对', () => {
  const text = ('Hello world. 你好😀\n').repeat(60);
  const chunks = splitLongText(text, 100);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => chunk.length <= 100));
  assert.ok(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk)));
});

test('ZIP 解析拒绝路径穿越和解压超限', () => {
  assert.equal(validateZipEntry({ name: 'word/document.xml', originalSize: 200 }, { count: 0, total: 0 }), true);
  assert.throws(() => validateZipEntry({ name: '../outside', originalSize: 1 }, { count: 0, total: 0 }), /安全解析/);
  assert.throws(() => validateZipEntry({ name: 'large', originalSize: 31 * 1024 * 1024 }, { count: 0, total: 0 }), /安全解析/);
  assert.throws(() => validateZipEntry({ name: 'small', originalSize: 1 }, { count: 5000, total: 0 }), /安全解析/);
});

test('HTML 和 XHTML 导出保留结构且不执行源脚本', () => {
  const dom = new JSDOM('');
  const original = { DOMParser: globalThis.DOMParser, XMLSerializer: globalThis.XMLSerializer, NodeFilter: globalThis.NodeFilter };
  Object.assign(globalThis, { DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer, NodeFilter: dom.window.NodeFilter });
  try {
    const parsed = parseMarkup('<!doctype html><title>Keep title</title><p>Hello <em>world</em></p><pre>Code</pre><p translate="no">Protected</p><script>globalThis.danger = true</script>');
    assert.deepEqual(parsed.segments.map(segment => segment.source), ['Hello', 'world']);
    const output = exportMarkup(parsed, ['你好', '世界']);
    assert.match(output, /<em>world<span/);
    assert.match(output, /<pre>Code<\/pre>/);
    assert.match(output, /你好/);
    assert.equal(dom.window.danger, undefined);
    const xml = parseMarkup('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Unchanged</title></head><body><p>Hello</p><img src="cover.png"/></body></html>', true);
    assert.deepEqual(xml.segments.map(segment => segment.source), ['Hello']);
    const translated = exportMarkup(xml, ['你好'], 'translated');
    assert.match(translated, /<p>你好<\/p>/);
    assert.match(translated, /cover.png/);
    assert.match(translated, /<title>Unchanged<\/title>/);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
    dom.window.close();
  }
});

test('文档页 mock 集成：文本/JSON/HTML/字幕和 DOCX/EPUB 保留资源导出、取消后继续', async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/documents.js', import.meta.url))], bundle: true, write: false,
    format: 'iife', platform: 'browser', logLevel: 'silent',
    plugins: [{ name: 'test-vendor', setup(builder) {
      builder.onResolve({ filter: /vendor\/fflate\.js$/ }, () => ({ path: fileURLToPath(new URL('../node_modules/fflate/esm/browser.js', import.meta.url)) }));
      builder.onResolve({ filter: /vendor\// }, args => ({ path: args.path, external: true }));
    } }],
  });
  const html = await readFile(new URL('../pages/documents.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/pages/documents.html', runScripts: 'dangerously' });
  const win = dom.window;
  Object.assign(win, { TextDecoder, TextEncoder, structuredClone });
  const blobs = [];
  win.URL.createObjectURL = blob => { blobs.push(blob); return 'blob:http://localhost/mock'; };
  win.URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = () => {};
  let holdNextRequest = false;
  let pendingResolve;
  let translateRequests = 0;
  win.chrome = { runtime: { sendMessage: async message => {
    if (message.type === 'settings') return { ok: true, settings: {} };
    if (message.type === 'cancel') { pendingResolve?.({ ok: false, error: '已取消' }); return { ok: true }; }
    if (message.type === 'translate') {
      translateRequests += 1;
      if (holdNextRequest) { holdNextRequest = false; return new Promise(resolve => { pendingResolve = resolve; }); }
      return { ok: true, translations: message.texts.map(text => `中文译文 ${text}`) };
    }
    throw new Error(`未知 mock 消息：${message.type}`);
  } } };
  const $ = id => win.document.getElementById(id);
  const wait = async predicate => {
    for (let index = 0; index < 100; index += 1) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`文档页超时：${$('document-status').textContent} ${$('document-error').textContent}`);
  };
  const load = async (name, bytes) => {
    Object.defineProperty($('document-file'), 'files', { configurable: true, value: [{ name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }] });
    $('document-file').dispatchEvent(new win.Event('change'));
    await wait(() => !$('translate-document').disabled);
  };
  const readBlob = blob => new Promise((resolve, reject) => {
    const reader = new win.FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
  try {
    win.eval(result.outputFiles[0].text);
    const docx = {
      '[Content_Types].xml': strToU8('<Types/>'),
      'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p></w:body></w:document>'),
      'word/media/image.png': new Uint8Array([1, 2, 3, 4]),
    };
    const epub = {
      mimetype: strToU8('application/epub+zip'),
      'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
      'OEBPS/content.opf': strToU8('<package><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'),
      'OEBPS/chapter.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Keep</title></head><body><p>Hello <em>world</em></p></body></html>'),
      'OEBPS/style.css': strToU8('body{color:red}'),
    };
    const fixtures = [
      { name: 'sample.txt', bytes: strToU8('Hello\n\nSecond paragraph') },
      { name: 'sample.json', bytes: strToU8('{"name":"Hello","count":42}') },
      { name: 'sample.html', bytes: strToU8('<p>Hello</p><script>throw Error("must not execute")</script>') },
      { name: 'sample.srt', bytes: strToU8('1\n00:00:01,000 --> 00:00:02,000\nHello world\n') },
      { name: 'sample.docx', bytes: zipSync(docx), archive: docx, translatedPart: 'word/document.xml', retained: 'word/media/image.png' },
      { name: 'sample.epub', bytes: zipSync(epub), archive: epub, translatedPart: 'OEBPS/chapter.xhtml', retained: 'OEBPS/style.css' },
    ];
    for (const fixture of fixtures) {
      await load(fixture.name, fixture.bytes);
      $('translate-document').click();
      await wait(() => $('document-status').textContent.startsWith('翻译完成'));
      $('export-document').click();
      await wait(() => $('document-status').textContent === '已生成并下载文件。');
      const bytes = await readBlob(blobs.at(-1));
      if (fixture.archive) {
        const archive = unzipSync(bytes);
        assert.match(strFromU8(archive[fixture.translatedPart]), /中文译文/);
        assert.deepEqual(archive[fixture.retained], fixture.archive[fixture.retained]);
        if (fixture.name.endsWith('.epub')) assert.equal(Object.keys(archive)[0], 'mimetype');
      } else assert.match(strFromU8(bytes), /中文译文/);
    }
    await load('cancel.txt', strToU8('Cancel this translation'));
    holdNextRequest = true;
    $('translate-document').click();
    await wait(() => Boolean(pendingResolve));
    $('cancel-document').click();
    await wait(() => $('document-status').textContent.startsWith('已取消'));
    assert.equal($('export-document').disabled, true);
    $('translate-document').click();
    await wait(() => $('document-status').textContent.startsWith('翻译完成'));
    assert.equal($('export-document').disabled, false);
    assert.equal(translateRequests, fixtures.length + 2);
  } finally { dom.window.close(); }
});
