const SUPPORTED = new Set(['txt', 'md', 'html', 'htm', 'json', 'srt', 'vtt', 'ass', 'ssa', 'lrc', 'docx', 'epub', 'pdf']);

export function detectFormat(name) {
  const extension = String(name).split('.').pop().toLowerCase();
  if (!SUPPORTED.has(extension)) throw new Error('不支持此文件格式。请选择 TXT、Markdown、HTML、JSON、字幕、DOCX、EPUB 或 PDF。');
  return extension === 'htm' ? 'html' : extension === 'ssa' ? 'ass' : extension;
}

export function isTranslatable(value) {
  return typeof value === 'string' && /\p{L}/u.test(value) && !/^\s*(?:https?:\/\/|data:|mailto:|file:\/\/|www\.)\S+\s*$/i.test(value);
}

export function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function applyTextEdits(text, edits) {
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  let cursor = 0;
  const output = [];
  for (const edit of ordered) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < cursor || edit.end < edit.start || edit.end > text.length) {
      throw new Error('文本区间无效或重叠。');
    }
    output.push(text.slice(cursor, edit.start), String(edit.text));
    cursor = edit.end;
  }
  output.push(text.slice(cursor));
  return output.join('');
}

function linesWithOffsets(text) {
  return [...text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)].filter(match => match[0].length).map(match => ({
    raw: match[0],
    text: match[0].replace(/[\r\n]+$/, ''),
    start: match.index,
    end: match.index + match[0].replace(/[\r\n]+$/, '').length,
  }));
}

function makeSegment(source, extra = {}) {
  return { source, ...extra };
}

export function parseParagraphs(text, markdown = false) {
  const segments = [];
  let fence = null;
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const start = group[0].start;
    const end = group[group.length - 1].end;
    const source = text.slice(start, end);
    if (isTranslatable(source)) segments.push(makeSegment(source, { start, end }));
    group = [];
  };
  for (const line of linesWithOffsets(text)) {
    const fenceMatch = markdown && line.text.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      flush();
      if (!fence) fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
      else if (fenceMatch[1][0] === fence.character && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence || !line.text.trim() || (markdown && (/^(?:\t| {4})/.test(line.text) || /^\s*(?:[-*_]\s*){3,}$/.test(line.text) || /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line.text)))) {
      flush();
      continue;
    }
    if (group.length && line.end - group[0].start > 1800) flush();
    group.push(line);
  }
  flush();
  return segments;
}

export function parseSubtitles(text, format) {
  const segments = [];
  const lines = linesWithOffsets(text);
  if (format === 'srt' || format === 'vtt') {
    let group = [];
    let cue = false;
    let metadata = false;
    const flush = () => {
      if (group.length) {
        const source = group.map(line => line.text).join('\n');
        if (isTranslatable(source)) segments.push(makeSegment(source, { start: group[0].start, end: group.at(-1).end, format }));
      }
      group = [];
    };
    for (const line of lines) {
      if (!line.text.trim()) { flush(); cue = false; metadata = false; continue; }
      if (/^(?:WEBVTT|NOTE(?:\s|$)|STYLE\s*$|REGION\s*$)/.test(line.text)) { flush(); cue = false; metadata = true; continue; }
      if (metadata) continue;
      if (/\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->\s+\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}/.test(line.text)) {
        flush(); cue = true; continue;
      }
      if (cue) group.push(line);
    }
    flush();
    return segments;
  }
  if (format === 'lrc') {
    for (const line of lines) {
      const match = line.text.match(/^((?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$/);
      if (match && isTranslatable(match[2])) segments.push(makeSegment(match[2], { start: line.start + match[1].length, end: line.end, prefix: match[1], format }));
    }
    return segments;
  }
  let inEvents = false;
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  for (const line of lines) {
    if (/^\[/.test(line.text.trim())) { inEvents = /^\[events\]$/i.test(line.text.trim()); continue; }
    if (!inEvents) continue;
    const formatMatch = line.text.match(/^Format:\s*(.+)$/i);
    if (formatMatch) { fields = formatMatch[1].split(',').map(value => value.trim().toLowerCase()); continue; }
    const dialogue = line.text.match(/^Dialogue:\s*/i);
    if (!dialogue) continue;
    const textIndex = fields.indexOf('text');
    if (textIndex !== fields.length - 1) throw new Error('此 ASS 文件的 Text 字段不是最后一列，暂不支持安全导出。');
    let offset = dialogue[0].length;
    for (let index = 0; index < textIndex; index += 1) {
      const comma = line.text.indexOf(',', offset);
      if (comma < 0) { offset = -1; break; }
      offset = comma + 1;
    }
    if (offset < 0) continue;
    const raw = line.text.slice(offset);
    const source = raw.replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ');
    if (isTranslatable(source)) segments.push(makeSegment(source, { start: line.start + offset, end: line.end, raw, format }));
  }
  return segments;
}

function subtitleText(value) {
  return String(value).replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

export function exportRangeDocument(text, segments, translations, mode = 'bilingual', format = 'txt') {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const edits = segments.map((segment, index) => {
    const translated = translations[index];
    if (typeof translated !== 'string') return null;
    let replacement = translated;
    if (['srt', 'vtt', 'lrc', 'ass'].includes(format)) replacement = subtitleText(replacement);
    if (format === 'lrc') {
      replacement = replacement.replace(/\n/g, ' ');
      if (mode === 'bilingual') replacement = `${segment.source}${newline}${segment.prefix}${replacement}`;
    } else if (format === 'ass') {
      replacement = replacement.replace(/[{}]/g, '').replace(/\\/g, '＼').replace(/\n/g, '\\N');
      const leadingTags = (segment.raw.match(/^(?:\{[^}]*\})+/) || [''])[0];
      replacement = mode === 'bilingual' ? `${segment.raw}\\N${replacement}` : `${leadingTags}${replacement}`;
    } else if (mode === 'bilingual') {
      replacement = `${segment.source}${newline}${replacement}`;
    }
    if (format !== 'ass') replacement = replacement.replace(/\r?\n/g, newline);
    return { start: segment.start, end: segment.end, text: replacement };
  }).filter(Boolean);
  return applyTextEdits(text, edits);
}

export function parseJsonDocument(text) {
  let value;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`JSON 解析失败：${error.message}`); }
  const segments = [];
  function visit(current, path) {
    if (typeof current === 'string') {
      if (isTranslatable(current)) segments.push(makeSegment(current, { path }));
    } else if (Array.isArray(current)) current.forEach((child, index) => visit(child, [...path, index]));
    else if (current && typeof current === 'object') Object.keys(current).forEach(key => visit(current[key], [...path, key]));
  }
  visit(value, []);
  return { value, segments };
}

export function exportJsonDocument(value, segments, translations, mode = 'bilingual') {
  let result = structuredClone(value);
  segments.forEach((segment, index) => {
    if (typeof translations[index] !== 'string') return;
    const translated = mode === 'bilingual' ? `${segment.source}\n${translations[index]}` : translations[index];
    if (!segment.path.length) { result = translated; return; }
    let parent = result;
    for (const key of segment.path.slice(0, -1)) parent = parent[key];
    Object.defineProperty(parent, segment.path.at(-1), { value: translated, enumerable: true, configurable: true, writable: true });
  });
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function splitLongText(text, maximum = 1800) {
  if (!Number.isInteger(maximum) || maximum < 20) throw new Error('文本块长度无效。');
  const result = [];
  let rest = text;
  while (rest.length > maximum) {
    const window = rest.slice(0, maximum);
    let cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。') + 1, window.lastIndexOf('. ') + 1, window.lastIndexOf(' '));
    if (cut < maximum / 3) cut = maximum;
    if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut -= 1;
    result.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) result.push(rest);
  return result;
}

export function parseMarkup(text, xml = false) {
  const document = new DOMParser().parseFromString(text, xml ? 'application/xhtml+xml' : 'text/html');
  if (document.querySelector('parsererror')) throw new Error('HTML/XHTML 结构无效，无法安全保留原文档。');
  const segments = [];
  const root = document.body || document.getElementsByTagNameNS('*', 'body')[0] || document.documentElement;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest('head,title,script,style,pre,code,noscript,textarea,svg,math,select,option')) continue;
    if (parent.closest('[translate="no"],.notranslate') || !isTranslatable(node.nodeValue)) continue;
    const raw = node.nodeValue;
    const leading = raw.match(/^\s*/)[0];
    const trailing = raw.match(/\s*$/)[0];
    segments.push(makeSegment(raw.trim(), { node, leading, trailing }));
  }
  return { document, segments, xml };
}

export function exportMarkup(parsed, translations, mode = 'bilingual', target = 'zh-CN') {
  const clone = parsed.document.cloneNode(true);
  const originalNodes = [];
  const clonedNodes = [];
  const walkOriginal = parsed.document.createTreeWalker(parsed.document, NodeFilter.SHOW_TEXT);
  const walkClone = clone.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walkOriginal.nextNode())) originalNodes.push(node);
  while ((node = walkClone.nextNode())) clonedNodes.push(node);
  const mapping = new Map(originalNodes.map((original, index) => [original, clonedNodes[index]]));
  parsed.segments.forEach((segment, index) => {
    if (typeof translations[index] !== 'string') return;
    const textNode = mapping.get(segment.node);
    if (mode === 'translated') textNode.nodeValue = `${segment.leading}${translations[index]}${segment.trailing}`;
    else {
      const span = clone.createElementNS(textNode.parentElement.namespaceURI || 'http://www.w3.org/1999/xhtml', 'span');
      span.setAttribute('lang', target);
      span.setAttribute('class', 'translation-paragraph');
      span.setAttribute('style', 'display:block;margin:.35em 0;color:#38536d;white-space:pre-wrap');
      span.textContent = translations[index];
      textNode.after(span);
    }
  });
  if (parsed.xml) return new XMLSerializer().serializeToString(clone);
  const doctype = clone.doctype ? `<!DOCTYPE ${clone.doctype.name}>\n` : '';
  return doctype + clone.documentElement.outerHTML;
}

export function validateZipEntry(entry, state, maximum = 100 * 1024 * 1024) {
  state.count += 1;
  state.total += entry.originalSize;
  if (state.count > 5000 || state.total > maximum || entry.originalSize > 30 * 1024 * 1024 || /(?:^|\/)\.\.(?:\/|$)/.test(entry.name) || entry.name.startsWith('/') || !Number.isFinite(entry.originalSize)) {
    throw new Error('压缩文档超出安全解析范围（最多 5000 项、总解压 100 MB、单项 30 MB），或包含无效路径。');
  }
  return true;
}
