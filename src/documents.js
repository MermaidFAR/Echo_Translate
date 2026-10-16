import { translateTexts, getSettings, downloadBlob, showError } from './client.js';
import { detectFormat, isTranslatable, parseParagraphs, parseSubtitles, exportRangeDocument, parseJsonDocument, exportJsonDocument, splitLongText, parseMarkup, exportMarkup, escapeXml, validateZipEntry } from './file-formats.js';

const $ = id => document.getElementById(id);
const MAX_FILE_SIZE = 40 * 1024 * 1024;
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const FONT_URL = 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf';
let current = null;
let translations = [];
let operation = null;
let generation = 0;
let fontBytes = null;
let previewCount = 80;
let pdfRenderTask = null;

function setStatus(message) { $('document-status').textContent = message; }
function setBusy(busy) {
  $('document-file').disabled = busy;
  $('translate-document').disabled = busy || !current?.segments.length;
  $('cancel-document').disabled = !busy;
  const complete = current?.segments.length && translations.length === current.segments.length && translations.every(value => typeof value === 'string');
  $('export-document').disabled = busy || !complete;
  $('export-preview').disabled = busy || !complete;
  $('export-mode').disabled = busy;
  for (const id of ['source-language', 'target-language', 'document-context']) $(id).disabled = busy;
}

function parseXml(text) {
  const result = new DOMParser().parseFromString(text, 'application/xml');
  if (result.querySelector('parsererror')) throw new Error('压缩文档中的 XML 无效。');
  return result;
}

function xmlText(document, original = '') {
  const declaration = original.match(/^\s*(<\?xml[^?]*\?>)/)?.[1] || '';
  return declaration + new XMLSerializer().serializeToString(document);
}

function wordTextNodes(paragraph) {
  return [...paragraph.getElementsByTagNameNS(WORD_NS, 't')].filter(text => {
    let parent = text.parentElement;
    while (parent && !(parent.namespaceURI === WORD_NS && parent.localName === 'p')) parent = parent.parentElement;
    return parent === paragraph;
  });
}

function appendWordText(parsed, run, value, initialBreak = false) {
  String(value).split(/\r?\n/).forEach((line, index) => {
    if (initialBreak || index) run.appendChild(parsed.createElementNS(WORD_NS, 'w:br'));
    const text = parsed.createElementNS(WORD_NS, 'w:t');
    text.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
    text.textContent = line;
    run.appendChild(text);
  });
}

async function unzipDocument(bytes) {
  const { unzipSync, strFromU8, strToU8, zipSync } = await import('../vendor/fflate.js');
  const state = { count: 0, total: 0 };
  let entries;
  try { entries = unzipSync(bytes, { filter: entry => validateZipEntry(entry, state) }); }
  catch (error) { throw new Error(`无法解压文档：${error.message}`); }
  return { entries, strFromU8, strToU8, zipSync };
}

async function readDocx(bytes) {
  const archive = await unzipDocument(bytes);
  if (!archive.entries['[Content_Types].xml'] || !archive.entries['word/document.xml']) throw new Error('这不是有效的 DOCX 文档。');
  const parts = [];
  const segments = [];
  const names = Object.keys(archive.entries).filter(name => /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(name));
  names.sort((a, b) => a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b));
  for (const name of names) {
    const raw = archive.strFromU8(archive.entries[name]);
    const parsed = parseXml(raw);
    const paragraphs = [...parsed.getElementsByTagNameNS(WORD_NS, 'p')];
    const part = { name, raw, parsed };
    parts.push(part);
    for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
      const texts = wordTextNodes(paragraph);
      const source = texts.map(node => node.textContent).join('');
      if (isTranslatable(source)) segments.push({ source, part, paragraphIndex, label: name === 'word/document.xml' ? '正文' : name });
    }
  }
  return {
    kind: 'docx', segments,
    note: '保留原 ZIP、图片、样式和表格结构。双语模式在原段落内追加译文；仅译文模式沿用首个文本片段样式。复杂文本框、修订、公式中的文字和精细字形样式可能无法完整翻译。修改后的文件会失去原数字签名。',
    async export(values, mode) {
      const entries = { ...archive.entries };
      const documents = new Map(parts.map(part => [part, part.parsed.cloneNode(true)]));
      segments.forEach((segment, index) => {
        const parsed = documents.get(segment.part);
        const paragraph = parsed.getElementsByTagNameNS(WORD_NS, 'p')[segment.paragraphIndex];
        const texts = wordTextNodes(paragraph);
        if (mode === 'translated') {
          texts.slice(1).forEach(text => { text.textContent = ''; });
          const first = texts[0];
          const fragment = parsed.createDocumentFragment();
          String(values[index]).split(/\r?\n/).forEach((line, lineIndex) => {
            if (lineIndex) fragment.appendChild(parsed.createElementNS(WORD_NS, 'w:br'));
            const text = first.cloneNode(false);
            text.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
            text.textContent = line;
            fragment.appendChild(text);
          });
          first.replaceWith(fragment);
        } else {
          const run = parsed.createElementNS(WORD_NS, 'w:r');
          const properties = paragraph.getElementsByTagNameNS(WORD_NS, 'rPr')[0];
          if (properties) run.appendChild(properties.cloneNode(true));
          appendWordText(parsed, run, values[index], true);
          paragraph.appendChild(run);
        }
      });
      parts.forEach(part => { entries[part.name] = archive.strToU8(xmlText(documents.get(part), part.raw)); });
      return new Blob([archive.zipSync(entries)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    },
  };
}

function normalizeZipPath(path) {
  const output = [];
  for (const part of path.split('/')) {
    if (part === '..') output.pop();
    else if (part && part !== '.') output.push(part);
  }
  return output.join('/');
}

async function readEpub(bytes) {
  const archive = await unzipDocument(bytes);
  const container = archive.entries['META-INF/container.xml'];
  if (!container) throw new Error('EPUB 缺少 META-INF/container.xml。');
  const rootfile = parseXml(archive.strFromU8(container)).getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path');
  if (!rootfile || !archive.entries[rootfile]) throw new Error('EPUB 的内容清单不存在。');
  const packageXml = parseXml(archive.strFromU8(archive.entries[rootfile]));
  const directory = rootfile.includes('/') ? rootfile.slice(0, rootfile.lastIndexOf('/') + 1) : '';
  const items = new Map([...packageXml.getElementsByTagNameNS('*', 'item')].map(item => [item.getAttribute('id'), item]));
  const spine = [...packageXml.getElementsByTagNameNS('*', 'itemref')];
  const parts = [];
  const segments = [];
  const seen = new Set();
  for (const reference of spine) {
    const item = items.get(reference.getAttribute('idref'));
    if (!item || !/xhtml|html/.test(item.getAttribute('media-type') || '')) continue;
    let href;
    try { href = decodeURIComponent(item.getAttribute('href').split('#')[0]); } catch { throw new Error('EPUB 包含无效的内容路径。'); }
    const name = normalizeZipPath(directory + href);
    if (seen.has(name)) continue;
    seen.add(name);
    if (!archive.entries[name]) throw new Error(`EPUB 缺少章节：${name}`);
    const raw = archive.strFromU8(archive.entries[name]);
    const parsed = parseMarkup(raw, true);
    const part = { name, parsed, offset: segments.length };
    parts.push(part);
    parsed.segments.forEach(segment => segments.push({ ...segment, label: `章节 ${parts.length}` }));
  }
  return {
    kind: 'epub', segments,
    note: '按 EPUB spine 顺序翻译章节，保留封面、图片、样式和其他 ZIP 内容。双语模式在原文本后追加译文。加密或 DRM 内容不支持；目录标题与非正文附件不自动改写。',
    async export(values, mode, target) {
      const entries = { ...archive.entries };
      for (const part of parts) entries[part.name] = archive.strToU8(exportMarkup(part.parsed, values.slice(part.offset, part.offset + part.parsed.segments.length), mode, target));
      const ordered = {};
      ordered.mimetype = [archive.strToU8('application/epub+zip'), { level: 0 }];
      for (const [name, data] of Object.entries(entries)) if (name !== 'mimetype') ordered[name] = data;
      return new Blob([archive.zipSync(ordered)], { type: 'application/epub+zip' });
    },
  };
}

async function readPdf(bytes, signal) {
  const pdfjs = await import('../vendor/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.mjs', import.meta.url).href;
  const task = pdfjs.getDocument({
    data: bytes.slice(), isEvalSupported: false, useSystemFonts: true,
    cMapUrl: new URL('../vendor/pdfjs/cmaps/', import.meta.url).href, cMapPacked: true,
    standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
    wasmUrl: new URL('../vendor/pdfjs/wasm/', import.meta.url).href,
  });
  const abort = () => { task.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  task.onPassword = (callback, reason) => { task.destroy(); showError($('document-error'), new Error(reason === 1 ? 'PDF 已加密，请先使用密码解密后导入。' : 'PDF 密码错误。')); };
  let pdf;
  try { pdf = await task.promise; }
  catch (error) { signal?.removeEventListener('abort', abort); throw error; }
  const segments = [];
  try {
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    signal?.throwIfAborted();
    setStatus(`正在提取 PDF 文字：${pageNumber}/${pdf.numPages} 页`);
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = [];
    let previousY = null;
    let line = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const y = item.transform?.[5];
      if (previousY !== null && Math.abs(y - previousY) > Math.max(3, Math.abs(item.transform?.[3] || 0) / 3)) { lines.push(line); line = ''; }
      const separator = line && !/\s$/.test(line) && !/^\s/.test(item.str) ? ' ' : '';
      line += separator + item.str;
      previousY = y;
      if (item.hasEOL) { lines.push(line); line = ''; previousY = null; }
    }
    if (line) lines.push(line);
    const text = lines.join('\n').trim();
    for (const source of splitLongText(text)) if (isTranslatable(source)) segments.push({ source, page: pageNumber, label: `第 ${pageNumber} 页` });
  }
  } catch (error) { await pdf.destroy(); throw error; }
  finally { signal?.removeEventListener('abort', abort); }
  return {
    kind: 'pdf', pdf, bytes, segments,
    note: 'PDF 按文本层顺序提取，双栏、公式和复杂表格的阅读顺序可能需要校对。扫描页不会自动 OCR；含文字的页面可翻译。导出保留原文页面，并另加单栏译文页面，不进行精准版式重排。',
    export: (values, mode) => exportPdf(bytes, pdf.numPages, segments, values, mode),
  };
}

function wrapFontText(text, font, size, maximumWidth) {
  const lines = [];
  let replaced = 0;
  const supported = new Set(font.getCharacterSet());
  for (const paragraph of String(text).replace(/\r/g, '').split('\n')) {
    let line = '';
    for (const raw of paragraph) {
      let character = raw === '\t' ? '    ' : raw;
      if (!supported.has(raw.codePointAt(0)) && raw !== '\t') { character = supported.has(0x25a1) ? '□' : '?'; replaced += 1; }
      if (line && font.widthOfTextAtSize(line + character, size) > maximumWidth) { lines.push(line); line = ''; }
      line += character;
    }
    lines.push(line);
  }
  return { lines, replaced };
}

async function exportPdf(bytes, pageCount, segments, values, mode) {
  if (!fontBytes) throw new Error('请先上传本地中文字体，或点击“下载开源中文字体”，再导出 PDF。');
  const { PDFDocument, rgb } = await import('../vendor/pdf-lib.js');
  const fontModule = await import('../vendor/fontkit.js');
  const output = await PDFDocument.create();
  output.registerFontkit(fontModule.default || fontModule.fontkit || fontModule);
  let font;
  try { font = await output.embedFont(fontBytes, { subset: true }); }
  catch (error) { throw new Error(`无法嵌入字体，请选择有效的 TTF/OTF 字体：${error.message}`); }
  const glyphs = new Set(font.getCharacterSet());
  if (![...'第页译文'].every(character => glyphs.has(character.codePointAt(0)))) throw new Error('所选字体不包含所需中文字形。请改用中文 TTF/OTF 字体。');
  const original = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = await output.copyPages(original, original.getPageIndices());
  let missingCharacters = 0;
  for (let index = 0; index < pageCount; index += 1) {
    const originalPage = pages[index];
    if (mode === 'bilingual') output.addPage(originalPage);
    const width = Math.max(280, originalPage.getWidth());
    const height = Math.max(360, originalPage.getHeight());
    const margin = Math.min(48, width / 10);
    const fontSize = 11;
    const leading = 17;
    const text = segments.map((segment, segmentIndex) => segment.page === index + 1 ? values[segmentIndex] : null).filter(value => value !== null).join('\n\n') || '本页未提取到可翻译的文本。扫描页面需要先进行 OCR。';
    const wrapped = wrapFontText(text, font, fontSize, width - margin * 2);
    missingCharacters += wrapped.replaced;
    let page;
    let y;
    let continuation = 0;
    const newPage = () => {
      page = output.addPage([width, height]);
      const heading = `第 ${index + 1} 页译文${continuation ? `（续 ${continuation}）` : ''}`;
      page.drawText(heading, { x: margin, y: height - margin, font, size: 12, color: rgb(0.22, 0.30, 0.38) });
      page.drawLine({ start: { x: margin, y: height - margin - 12 }, end: { x: width - margin, y: height - margin - 12 }, thickness: 0.5, color: rgb(0.8, 0.83, 0.86) });
      y = height - margin - 38;
      continuation += 1;
    };
    newPage();
    for (const line of wrapped.lines) {
      if (y < margin) newPage();
      if (line) page.drawText(line, { x: margin, y, font, size: fontSize, color: rgb(0.12, 0.15, 0.19) });
      y -= leading;
    }
  }
  output.setTitle(current?.name || '双语文档');
  output.setCreator('个人 API 双语翻译');
  const result = await output.save();
  if (missingCharacters) $('document-note').textContent = `已导出。有 ${missingCharacters} 个字符不在所选字体中，已用方框或问号标记；请换用覆盖这些字符的字体后重新导出。`;
  return new Blob([result], { type: 'application/pdf' });
}

async function readDocument(file, signal) {
  if (file.size > MAX_FILE_SIZE) throw new Error('文件超过 40 MB，请分割后再导入。');
  const kind = detectFormat(file.name);
  if (['docx', 'epub', 'pdf'].includes(kind)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    signal?.throwIfAborted();
    const parsed = kind === 'docx' ? await readDocx(bytes) : kind === 'epub' ? await readEpub(bytes) : await readPdf(bytes, signal);
    return { ...parsed, name: file.name };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  let text;
  try {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch { throw new Error('文件不是有效的 UTF-8/UTF-16 文本。请先另存为 UTF-8 后重试，避免乱码。'); }
  if (text.includes('\0')) throw new Error('文件包含二进制数据，无法按文本翻译。');
  let segments;
  let exportFile;
  let note = '导出保留原段落结构。请在导出前校对译文。';
  if (kind === 'json') {
    const parsed = parseJsonDocument(text);
    segments = parsed.segments;
    exportFile = (values, mode) => new Blob([exportJsonDocument(parsed.value, segments, values, mode)], { type: 'application/json;charset=utf-8' });
    note = '只翻译 JSON 字符串值，保留键名、数组和数据类型。双语模式把原文与译文放在同一个字符串中。URL 不翻译。';
  } else if (kind === 'html') {
    const parsed = parseMarkup(text);
    segments = parsed.segments;
    exportFile = (values, mode, target) => new Blob([exportMarkup(parsed, values, mode, target)], { type: 'text/html;charset=utf-8' });
    note = '保留 HTML 结构，在文本后追加译文。脚本、样式、代码和 translate="no" 内容不翻译。预览只显示文字，不执行导入文件中的脚本。导出的原 HTML 仍保留其原有脚本。';
  } else {
    segments = ['srt', 'vtt', 'ass', 'lrc'].includes(kind) ? parseSubtitles(text, kind) : parseParagraphs(text, kind === 'md');
    exportFile = (values, mode) => new Blob([exportRangeDocument(text, segments, values, mode, kind)], { type: 'text/plain;charset=utf-8' });
    if (['srt', 'vtt', 'lrc', 'ass'].includes(kind)) note = '保留时间轴、字幕编号和元数据。ASS 双语模式在同一事件内追加译文；仅译文模式保留开头的样式标签，段内精细标签位置不保证一致。';
    if (kind === 'md') note = 'Markdown 代码围栏、缩进代码与分隔线保留；翻译时要求模型保留内联链接、标记和代码。请校对复杂表格与内联语法。';
  }
  return { kind, name: file.name, segments, export: exportFile, note };
}

function renderPreview(reset = false) {
  if (reset) { previewCount = 80; $('document-preview').replaceChildren(); }
  const targetCount = Math.min(previewCount, current?.segments.length || 0);
  const fragment = document.createDocumentFragment();
  for (let index = $('document-preview').children.length; index < targetCount; index += 1) {
    const segment = current.segments[index];
    const article = document.createElement('article');
    article.className = 'translation-pair';
    article.dataset.index = index;
    const heading = document.createElement('p');
    heading.className = 'muted';
    heading.textContent = `${index + 1}${segment.label ? ` · ${segment.label}` : ''}`;
    const source = document.createElement('pre');
    source.className = 'document-source';
    source.textContent = segment.source;
    const translated = document.createElement('pre');
    translated.className = 'document-translation';
    translated.textContent = translations[index] ?? '等待翻译';
    translated.lang = $('target-language').value || 'zh-CN';
    article.append(heading, source, translated);
    fragment.appendChild(article);
  }
  $('document-preview').appendChild(fragment);
  for (const article of $('document-preview').children) article.querySelector('.document-translation').textContent = translations[Number(article.dataset.index)] ?? '等待翻译';
  $('show-more-preview').hidden = targetCount >= (current?.segments.length || 0);
  $('preview-summary').textContent = current ? `${current.segments.length} 个文本段落 · 当前显示 ${targetCount} 个` : '';
}

async function renderPdfPage() {
  if (!current?.pdf) return;
  if (pdfRenderTask) { pdfRenderTask.cancel(); pdfRenderTask = null; }
  const active = current;
  const page = await active.pdf.getPage(Number($('pdf-page-select').value || 1));
  if (current !== active) return;
  const original = page.getViewport({ scale: 1 });
  const scale = Math.min(1.4, 900 / original.width);
  const viewport = page.getViewport({ scale });
  const canvas = $('pdf-page-canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.maxWidth = '100%';
  canvas.style.height = 'auto';
  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
  pdfRenderTask = task;
  try { await task.promise; } catch (error) { if (error.name !== 'RenderingCancelledException') throw error; }
  finally { if (pdfRenderTask === task) pdfRenderTask = null; }
}

async function loadFile() {
  const file = $('document-file').files[0];
  if (!file) return;
  const token = ++generation;
  operation?.abort();
  const controller = new AbortController();
  operation = controller;
  if (pdfRenderTask) { pdfRenderTask.cancel(); pdfRenderTask = null; }
  if (current?.pdf) await current.pdf.destroy();
  current = null;
  translations = [];
  $('document-error').textContent = '';
  $('document-note').textContent = '';
  $('document-preview').replaceChildren();
  $('pdf-original-panel').hidden = true;
  $('pdf-font-panel').hidden = true;
  $('document-progress').value = 0;
  setBusy(true);
  setStatus('正在读取和提取文档…');
  try {
    const parsed = await readDocument(file, controller.signal);
    if (controller.signal.aborted) { await parsed.pdf?.destroy(); throw new DOMException('已取消', 'AbortError'); }
    if (token !== generation) { await parsed.pdf?.destroy(); return; }
    if (!parsed.segments.length) { await parsed.pdf?.destroy(); throw new Error(parsed.kind === 'pdf' ? '此 PDF 没有可提取文字。请先对扫描件进行 OCR。' : '文件中没有可翻译的文字。'); }
    if (parsed.segments.length > 30000 || parsed.segments.reduce((sum, segment) => sum + segment.source.length, 0) > 3000000) { await parsed.pdf?.destroy(); throw new Error('文档文字超过本页处理范围（30,000 段或 300 万字符），请分割后导入。'); }
    current = parsed;
    translations = new Array(parsed.segments.length).fill(null);
    $('document-note').textContent = parsed.note;
    setStatus(`已读取 ${file.name}，共 ${parsed.segments.length} 个待翻译段落。`);
    renderPreview(true);
    if (parsed.pdf) {
      $('pdf-original-panel').hidden = false;
      $('pdf-font-panel').hidden = false;
      $('pdf-page-select').replaceChildren(...Array.from({ length: parsed.pdf.numPages }, (_, index) => new Option(String(index + 1), String(index + 1))));
      await renderPdfPage();
    }
  } catch (error) {
    if (controller.signal.aborted || error.name === 'AbortError') setStatus('已取消文件读取。');
    else { showError($('document-error'), error); setStatus('文件读取失败。'); }
  } finally { if (operation === controller) operation = null; if (token === generation) setBusy(false); }
}

async function translateDocument() {
  if (!current || operation) return;
  const target = $('target-language').value.trim();
  if (!target) { showError($('document-error'), new Error('请填写目标语言。')); return; }
  const controller = new AbortController();
  operation = controller;
  const active = current;
  const jobs = [];
  const results = new Map();
  active.segments.forEach((segment, segmentIndex) => {
    if (typeof translations[segmentIndex] === 'string') return;
    const parts = splitLongText(segment.source);
    results.set(segmentIndex, { total: parts.length, parts: new Array(parts.length) });
    parts.forEach((text, partIndex) => jobs.push({ text, segmentIndex, partIndex }));
  });
  $('document-error').textContent = '';
  $('document-progress').max = Math.max(jobs.length, 1);
  $('document-progress').value = 0;
  setBusy(true);
  const context = `这是 ${active.kind.toUpperCase()} 文档的文字片段。逐项翻译，保留换行、Markdown/HTML 标记、字幕标签、代码及占位符；不要添加说明。${$('document-context').value.trim()}`;
  try {
    for (let offset = 0; offset < jobs.length; offset += 6) {
      if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
      const batch = jobs.slice(offset, offset + 6);
      setStatus(`正在翻译：${offset}/${jobs.length} 个文本块。已完成段落可在下方校对。`);
      const values = await translateTexts(batch.map(job => job.text), { source: $('source-language').value.trim() || 'auto', target, context, mode: 'translate', signal: controller.signal });
      if (controller.signal.aborted || current !== active) throw new DOMException('已取消', 'AbortError');
      if (!Array.isArray(values) || values.length !== batch.length || values.some(value => typeof value !== 'string' || !value.trim())) throw new Error('翻译服务返回的段落数量或内容无效，请重试。');
      batch.forEach((job, index) => {
        const result = results.get(job.segmentIndex);
        result.parts[job.partIndex] = values[index];
        if (result.parts.filter(value => typeof value === 'string').length === result.total) translations[job.segmentIndex] = result.parts.join('');
      });
      $('document-progress').value = Math.min(offset + batch.length, jobs.length);
      renderPreview();
    }
    setStatus(`翻译完成：${active.segments.length} 个段落。可选择双语或仅译文导出。`);
  } catch (error) {
    if (controller.signal.aborted || error.name === 'AbortError') setStatus('已取消。已完成的段落保留，点击“开始翻译”可继续。');
    else { showError($('document-error'), error); setStatus('翻译中断。已完成的段落保留，可重试继续。'); }
  } finally { if (operation === controller) operation = null; setBusy(false); }
}

async function exportDocument() {
  if (!current || translations.some(value => typeof value !== 'string')) return;
  const active = current;
  $('document-error').textContent = '';
  setBusy(true);
  $('cancel-document').disabled = true;
  setStatus('正在生成导出文件…');
  try {
    const mode = $('export-mode').value;
    const blob = await active.export(translations, mode, $('target-language').value.trim() || 'zh-CN');
    const stem = active.name.replace(/\.[^.]+$/, '');
    downloadBlob(blob, `${stem}.${mode === 'bilingual' ? '双语' : '译文'}.${active.kind}`);
    setStatus('已生成并下载文件。');
  } catch (error) { showError($('document-error'), error); setStatus('导出失败，译文仍保留在本页。'); }
  finally { setBusy(false); }
}

function exportPreview() {
  if (!current) return;
  const pairs = current.segments.map((segment, index) => `<article><p class="label">${index + 1} ${escapeXml(segment.label || '')}</p><div class="source">${escapeXml(segment.source)}</div><div class="translation">${escapeXml(translations[index] || '')}</div></article>`).join('\n');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeXml(current.name)} · 双语</title><style>body{max-width:1000px;margin:32px auto;padding:0 20px;font:16px/1.7 system-ui;color:#213445}article{padding:20px 0;border-bottom:1px solid #ddd}.source,.translation{white-space:pre-wrap;overflow-wrap:anywhere}.translation{margin-top:12px;color:#285879}.label{color:#778692;font-size:12px}@media print{article{break-inside:avoid}}</style><h1>${escapeXml(current.name)}</h1>${pairs}</html>`;
  downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${current.name.replace(/\.[^.]+$/, '')}.双语预览.html`);
}

$('document-file').addEventListener('change', loadFile);
$('translate-document').addEventListener('click', translateDocument);
$('cancel-document').addEventListener('click', () => operation?.abort());
$('export-document').addEventListener('click', exportDocument);
$('export-preview').addEventListener('click', exportPreview);
for (const id of ['source-language', 'target-language', 'document-context']) $(id).addEventListener('change', () => {
  if (!current || !translations.some(value => typeof value === 'string')) return;
  translations = new Array(current.segments.length).fill(null);
  $('document-progress').value = 0;
  setStatus('翻译条件已改变，请重新开始翻译。');
  renderPreview();
  setBusy(false);
});
$('show-more-preview').addEventListener('click', () => { previewCount += 100; renderPreview(); });
$('pdf-page-select').addEventListener('change', () => renderPdfPage().catch(error => showError($('document-error'), error)));
$('pdf-font-file').addEventListener('change', async () => {
  const file = $('pdf-font-file').files[0];
  if (!file) return;
  try {
    if (file.size > 30 * 1024 * 1024) throw new Error('字体超过 30 MB，请选择较小的 TTF/OTF 字体。');
    fontBytes = new Uint8Array(await file.arrayBuffer());
    $('pdf-font-status').textContent = `已载入字体：${file.name}`;
  } catch (error) { $('pdf-font-status').textContent = error.message; }
});
$('download-pdf-font').addEventListener('click', async () => {
  const button = $('download-pdf-font');
  button.disabled = true;
  $('pdf-font-status').textContent = '正在从 Noto 官方 GitHub 仓库下载字体…';
  try {
    const response = await fetch(FONT_URL, { signal: AbortSignal.timeout(120000), credentials: 'omit' });
    if (!response.ok) throw new Error(`字体下载失败（HTTP ${response.status}）。可改用本地字体上传。`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 30 * 1024 * 1024 || bytes.length < 10000) throw new Error('字体文件无效或超过 30 MB。');
    fontBytes = bytes;
    $('pdf-font-status').textContent = '已载入 Noto Sans CJK SC 开源字体（SIL Open Font License）。';
  } catch (error) { $('pdf-font-status').textContent = `${error.message} 您也可以上传本地字体。`; }
  finally { button.disabled = false; }
});
getSettings().then(settings => {
  $('source-language').value = settings.sourceLanguage || settings.source || 'auto';
  $('target-language').value = settings.targetLanguage || settings.target || 'zh-CN';
}).catch(error => showError($('document-error'), error));
