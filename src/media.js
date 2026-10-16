import { translateTexts, getSettings, downloadBlob } from './client.js';

const style = document.createElement('style');
style.textContent = `
  .media-page{max-width:1600px;margin:0 auto;padding:28px;color:#172637}.media-header{display:flex;justify-content:space-between;gap:24px;align-items:center}.media-header h1{margin:0 0 6px}.media-header p{margin:0 0 20px;color:#52687c}.media-header nav{display:flex;gap:18px;white-space:nowrap}
  .media-toolbar,.media-preview,.media-editor{background:#fff;border:1px solid #d4dfe7;border-radius:12px;padding:18px;margin-bottom:18px}.media-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:8px 0}.media-row>label{display:flex;gap:7px;align-items:center}.media-grow{flex:1;min-width:220px}.media-grow input{width:100%}.media-note{font-size:13px;color:#566c7c;line-height:1.6}.media-status{font-size:14px;white-space:pre-wrap;margin-bottom:0}.media-status.error{color:#b12a38}.media-layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:18px}.media-preview{min-width:0;align-self:start}.media-editor h2{font-size:18px;margin:0}.media-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.media-editor label{display:flex;flex-direction:column;gap:4px;margin-bottom:9px}.media-editor .media-row label{flex-direction:row}.media-editor input[type=number]{min-width:0;width:100%}.media-editor input[type=color]{height:35px;width:100%}.media-editor textarea{resize:vertical;width:100%;box-sizing:border-box}.media-editor fieldset{border:1px solid #d4dfe7;border-radius:8px;padding:12px;min-width:0}.media-editor fieldset[disabled]{opacity:.6}
  #canvas-stage{position:relative;overflow:auto;max-height:80vh;background:repeating-conic-gradient(#e5eaf0 0 25%,#f4f6f8 0 50%) 0/20px 20px;border-radius:8px}#image-canvas{display:block;width:100%;height:auto;touch-action:none;cursor:crosshair}#image-canvas[hidden]{display:none}#media-empty{padding:100px 20px;text-align:center;color:#637b8c;line-height:2}#image-size,#block-count{font-size:13px;color:#5a7183}#block-list{max-height:240px;overflow:auto;margin:10px 0;display:grid;gap:6px}#block-list button{display:block;width:100%;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:8px}#block-list button[aria-pressed=true]{background:#e4f1fa;border-color:#3183ac}#target-language{width:90px}.media-page input,.media-page select,.media-page textarea,.media-page button{font:inherit}.media-page button{cursor:pointer}.media-page button:disabled{cursor:default;opacity:.5}.media-page footer{padding:4px 0 20px}@media(max-width:950px){.media-layout{grid-template-columns:1fr}.media-header{align-items:flex-start;flex-direction:column;gap:0}.media-page{padding:16px}.media-editor{width:auto}}`;
document.head.append(style);

const $ = id => document.getElementById(id);
const canvas = $('image-canvas');
const context = canvas.getContext('2d');
const status = $('media-status');
let image;
let blocks = [];
let selectedId;
let busy = false;
let worker;
let operation;
let job = 0;
let fileName = 'image';
let drag;
let region;

function notice(message, error = false) { status.textContent = message; status.classList.toggle('error', error); }
function selected() { return blocks.find(block => block.id === selectedId); }
function clamp(number, minimum, maximum) { return Math.min(maximum, Math.max(minimum, Number(number) || 0)); }
function waitWithSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function updateButtons() {
  $('recognize').disabled = busy || !image;
  $('translate').disabled = busy || !blocks.some(block => block.text.trim());
  $('load-url').disabled = busy;
  $('image-file').disabled = busy;
  $('add-box').disabled = busy || !image;
  $('export-png').disabled = busy || !image;
  $('export-txt').disabled = busy || !blocks.length;
  $('cancel').hidden = !busy;
  $('block-editor').disabled = busy || !selected();
}

function wrapText(text, maxWidth, fontSize) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph) { lines.push(''); continue; }
    let line = '';
    const tokens = paragraph.match(/[A-Za-z0-9_]+(?:['’-][A-Za-z0-9_]+)*\s*|\s+|./gu) || [];
    for (const token of tokens) {
      if (context.measureText(line + token).width <= maxWidth) { line += token; continue; }
      if (line.trim()) { lines.push(line.trimEnd()); line = ''; }
      if (context.measureText(token).width <= maxWidth) { line = token.trimStart(); continue; }
      for (const character of token) {
        if (line && context.measureText(line + character).width > maxWidth) { lines.push(line); line = ''; }
        line += character;
      }
    }
    if (line || !lines.length) lines.push(line.trimEnd());
  }
  return { lines, lineHeight: fontSize * 1.25 };
}

function drawBlock(block) {
  if (!block.translated.trim()) return;
  const padding = Math.max(2, Math.min(8, block.width * 0.04));
  context.save();
  context.globalAlpha = block.opacity;
  context.fillStyle = block.background;
  context.fillRect(block.x, block.y, block.width, block.height);
  context.globalAlpha = 1;
  context.beginPath();
  context.rect(block.x, block.y, block.width, block.height);
  context.clip();
  context.fillStyle = block.color;
  context.textBaseline = 'top';
  const availableWidth = Math.max(1, block.width - padding * 2);
  const availableHeight = Math.max(1, block.height - padding * 2);
  let fontSize = block.fontSize;
  if (block.vertical) {
    const chars = Array.from(block.translated.replace(/\n/g, ''));
    while (fontSize > 8 && Math.floor(availableHeight / (fontSize * 1.15)) * Math.floor(availableWidth / (fontSize * 1.3)) < chars.length) fontSize -= 1;
    context.font = `${fontSize}px system-ui,"Noto Sans CJK SC","Microsoft YaHei",sans-serif`;
    const rows = Math.max(1, Math.floor(availableHeight / (fontSize * 1.15)));
    chars.forEach((character, index) => {
      const column = Math.floor(index / rows);
      const row = index % rows;
      context.fillText(character, block.x + block.width - padding - fontSize - column * fontSize * 1.3, block.y + padding + row * fontSize * 1.15);
    });
  } else {
    let layout;
    do {
      context.font = `${fontSize}px system-ui,"Noto Sans CJK SC","Microsoft YaHei",sans-serif`;
      layout = wrapText(block.translated, availableWidth, fontSize);
      if (layout.lines.length * layout.lineHeight <= availableHeight || fontSize <= 8) break;
      fontSize -= 1;
    } while (fontSize >= 8);
    const top = block.y + padding + Math.max(0, (availableHeight - layout.lines.length * layout.lineHeight) / 2);
    layout.lines.forEach((line, index) => {
      const left = block.x + padding + Math.max(0, (availableWidth - context.measureText(line).width) / 2);
      context.fillText(line, left, top + index * layout.lineHeight);
    });
  }
  context.restore();
}

function draw(includeSelection = true, forceOverlay = false) {
  if (!image) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  if ($('overlay-enabled').checked || forceOverlay) for (const block of blocks) drawBlock(block);
  if (!includeSelection) return;
  const scale = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
  context.save();
  for (const block of blocks) {
    context.lineWidth = (block.id === selectedId ? 2.5 : 1) * scale;
    context.strokeStyle = block.id === selectedId ? '#0075b5' : '#16a378';
    context.setLineDash(block.id === selectedId ? [] : [4 * scale, 3 * scale]);
    context.strokeRect(block.x, block.y, block.width, block.height);
  }
  if (region) { context.lineWidth = 2 * scale; context.strokeStyle = '#d27600'; context.setLineDash([8 * scale, 4 * scale]); context.strokeRect(region.x, region.y, region.width, region.height); }
  context.restore();
}

function refreshList() {
  $('block-count').textContent = `${blocks.length} 个`;
  const buttons = blocks.map((block, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${index + 1}. ${block.translated || block.text || '空白文字框'}`;
    button.setAttribute('aria-pressed', String(block.id === selectedId));
    button.addEventListener('click', () => { selectedId = block.id; refreshList(); updateEditor(); draw(); });
    return button;
  });
  $('block-list').replaceChildren(...buttons);
  updateButtons();
}

function updateEditor() {
  const block = selected();
  $('block-editor').disabled = busy || !block;
  for (const [name, property] of [['source', 'text'], ['translation', 'translated'], ['x', 'x'], ['y', 'y'], ['width', 'width'], ['height', 'height'], ['font', 'fontSize'], ['opacity', 'opacity'], ['color', 'color'], ['background', 'background']]) {
    if (block) $(`block-${name}`).value = typeof block[property] === 'number' ? Math.round(block[property] * 100) / 100 : block[property];
  }
  $('block-vertical').checked = !!block?.vertical;
}

function makeBlock(text, box) {
  return { id: crypto.randomUUID(), text: text.trim(), translated: '', x: box.x, y: box.y, width: box.width, height: box.height, fontSize: clamp(box.height * 0.7, 12, 48), color: '#172637', background: '#ffffff', opacity: 0.96, vertical: false };
}

async function loadImage(blob, name) {
  if (!blob.type.startsWith('image/')) throw new Error('读取的文件不是图片');
  if (blob.size > 40 * 1024 * 1024) throw new Error('图片文件不能超过 40 MB');
  const url = URL.createObjectURL(blob);
  const nextImage = new Image();
  try {
    await new Promise((resolve, reject) => { nextImage.onload = resolve; nextImage.onerror = () => reject(new Error('无法解码图片，请尝试 PNG、JPEG 或 WebP 格式')); nextImage.src = url; });
    if (nextImage.naturalWidth * nextImage.naturalHeight > 40 * 1024 * 1024) throw new Error('图片超过 4000 万像素，请裁切后分段处理');
    image = nextImage;
    fileName = name.replace(/\.[^.]+$/, '') || 'image';
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.hidden = false;
    $('media-empty').hidden = true;
    $('image-name').textContent = name;
    $('image-size').textContent = `${canvas.width} × ${canvas.height}`;
    blocks = [];
    selectedId = undefined;
    region = undefined;
    $('region-info').textContent = '识别范围：整张图片';
    refreshList();
    updateEditor();
    draw();
    notice('图片已载入。选择正确的文字语言后点击“识别文字”；也可以手动新增文字框。');
  } finally { URL.revokeObjectURL(url); }
}

async function loadImageUrl() {
  const value = $('image-url').value.trim();
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入完整图片地址'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('图片地址仅支持 HTTP / HTTPS；本地图片请使用文件选择');
  notice('正在读取图片地址…');
  const response = await chrome.runtime.sendMessage({ type: 'fetchImage', url: url.href });
  if (!response?.ok) throw new Error(response?.error || '图片下载失败；可将图片保存到本地再导入');
  if (typeof response.dataUrl !== 'string' || !response.dataUrl.startsWith('data:image/')) throw new Error('服务器未返回可用图片');
  const blob = await (await fetch(response.dataUrl)).blob();
  await loadImage(blob, decodeURIComponent(url.pathname.split('/').pop() || 'remote-image'));
}

function ocrLines(data, width, height) {
  const lines = data.blocks?.flatMap(block => block.paragraphs?.flatMap(paragraph => paragraph.lines || []) || []) || data.lines || [];
  if (lines.length) return lines;
  if (data.words?.length) return data.words;
  if (data.text?.trim()) return [{ text: data.text, bbox: { x0: 0, y0: 0, x1: width, y1: height } }];
  return [];
}

async function recognize() {
  if (!image || busy) return;
  if (!globalThis.Tesseract?.createWorker) throw new Error('本地 OCR 组件未加载，请检查扩展是否完整构建');
  busy = true;
  const controller = new AbortController();
  operation = controller;
  let currentWorker;
  const current = ++job;
  updateButtons();
  try {
    notice('正在启动本地 OCR；首次使用所选语言时会下载语言数据…');
    const starting = Tesseract.createWorker($('ocr-language').value, 1, {
      workerPath: chrome.runtime.getURL('vendor/tesseract/worker.min.js'),
      corePath: chrome.runtime.getURL('vendor/tesseract/core/'),
      langPath: 'https://tessdata.projectnaptha.com/4.0.0',
      workerBlobURL: false,
      errorHandler(error) { if (current === job) notice(`OCR 识别失败：${String(error)}`, true); },
      logger(message) {
        if (current !== job) return;
        const progress = Number.isFinite(message.progress) ? ` ${Math.round(message.progress * 100)}%` : '';
        const labels = { 'loading tesseract core': '加载 OCR 引擎', 'initializing tesseract': '初始化 OCR', 'loading language traineddata': '下载 / 读取语言数据', 'initializing api': '初始化识别语言', 'recognizing text': '识别文字' };
        notice(`${labels[message.status] || message.status}${progress}`);
      },
    });
    starting.then(created => { if (controller.signal.aborted) created.terminate(); }, () => {});
    currentWorker = await waitWithSignal(starting, controller.signal);
    if (current !== job) { await currentWorker.terminate(); return; }
    worker = currentWorker;
    const bounds = region ? { ...region } : { x: 0, y: 0, width: canvas.width, height: canvas.height };
    const input = document.createElement('canvas');
    input.width = bounds.width; input.height = bounds.height;
    input.getContext('2d').drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
    const result = await waitWithSignal(worker.recognize(input, {}, { blocks: true, text: true }), controller.signal);
    if (current !== job) return;
    blocks = ocrLines(result.data, bounds.width, bounds.height).filter(line => line.text?.trim() && line.bbox).map(line => {
      const x = clamp(line.bbox.x0 + bounds.x, 0, canvas.width - 1);
      const y = clamp(line.bbox.y0 + bounds.y, 0, canvas.height - 1);
      return makeBlock(line.text, { x, y, width: clamp(line.bbox.x1 - line.bbox.x0, 1, canvas.width - x), height: clamp(line.bbox.y1 - line.bbox.y0, 1, canvas.height - y) });
    });
    selectedId = blocks[0]?.id;
    refreshList();
    updateEditor();
    draw();
    notice(blocks.length ? `识别到 ${blocks.length} 个文字框。可校正原文、移动和调整框，再点击翻译。` : '未识别到文字。请确认 OCR 语言，尝试更清晰图片，或手动新增文字框。');
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    notice('OCR 已停止，可以重新选择图片或开始识别。');
  } finally {
    if (currentWorker) await currentWorker.terminate();
    if (worker === currentWorker) worker = undefined;
    if (operation === controller) operation = undefined;
    busy = false;
    updateButtons();
  }
}

async function translate() {
  if (busy) return;
  const pending = blocks.filter(block => block.text.trim());
  if (!pending.length) throw new Error('请先识别文字，或新增文字框填写原文');
  busy = true;
  const controller = new AbortController();
  operation = controller;
  const current = ++job;
  updateButtons();
  try {
    for (let index = 0; index < pending.length; index += 30) {
      if (current !== job) break;
      const batch = pending.slice(index, index + 30);
      notice(`正在翻译 ${index + 1}–${Math.min(index + 30, pending.length)} / ${pending.length} 个文字框…`);
      const translated = await translateTexts(batch.map(block => block.text), { source: 'auto', target: $('target-language').value.trim() || 'zh-CN', context: '图片与漫画文字。保持对白语气和专有名词；译文用于覆盖原图，请简洁自然。', mode: 'translate', signal: controller.signal });
      if (current !== job) break;
      if (!Array.isArray(translated) || translated.length !== batch.length) throw new Error('翻译结果数量与文字框不一致');
      batch.forEach((block, item) => { block.translated = translated[item]; });
      refreshList();
      updateEditor();
      draw();
    }
    notice(current === job ? '翻译完成。可以编辑译文、文字框与字号，然后导出 PNG / TXT。导出 PNG 自动使用译文覆盖。' : '已停止后续翻译，保留已经完成的结果。');
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    notice('已取消翻译，保留已经完成的结果。');
  } finally { if (operation === controller) operation = undefined; busy = false; updateButtons(); }
}

async function exportPng() {
  draw(false, true);
  try {
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('无法生成 PNG 图片')), 'image/png'));
    downloadBlob(blob, `${fileName}-translated.png`);
  } finally { draw(); }
}

function exportText() {
  const text = blocks.map((block, index) => `【${index + 1}】\n原文：${block.text}\n译文：${block.translated}`).join('\n\n');
  downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${fileName}-translated.txt`);
}

function run(action) { return (...args) => Promise.resolve().then(() => action(...args)).catch(error => notice(error.message || String(error), true)); }
$('image-file').addEventListener('change', run(async event => { const file = event.target.files[0]; if (file) await loadImage(file, file.name); }));
$('load-url').addEventListener('click', run(loadImageUrl));
$('recognize').addEventListener('click', run(recognize));
$('translate').addEventListener('click', run(translate));
$('export-png').addEventListener('click', run(exportPng));
$('export-txt').addEventListener('click', exportText);
$('overlay-enabled').addEventListener('change', () => draw());
$('clear-region').addEventListener('click', () => { if (busy) return; region = undefined; $('select-region').checked = false; $('region-info').textContent = '识别范围：整张图片'; draw(); });
$('cancel').addEventListener('click', run(async () => {
  job += 1;
  operation?.abort(new DOMException('已取消', 'AbortError'));
  if (worker) { const active = worker; worker = undefined; await active.terminate(); }
  notice('已请求停止，保留已经完成的结果。');
}));
$('add-box').addEventListener('click', () => {
  if (!image || busy) return;
  const block = makeBlock('', { x: Math.round(canvas.width * 0.1), y: Math.round(canvas.height * 0.1), width: Math.min(300, Math.round(canvas.width * 0.4)), height: Math.min(120, Math.round(canvas.height * 0.2)) });
  blocks.push(block);
  selectedId = block.id;
  refreshList(); updateEditor(); draw(); $('block-source').focus();
});
$('delete-box').addEventListener('click', () => { blocks = blocks.filter(block => block.id !== selectedId); selectedId = blocks[0]?.id; refreshList(); updateEditor(); draw(); });

for (const [name, property] of [['source', 'text'], ['translation', 'translated'], ['x', 'x'], ['y', 'y'], ['width', 'width'], ['height', 'height'], ['font', 'fontSize'], ['opacity', 'opacity'], ['color', 'color'], ['background', 'background']]) {
  $(`block-${name}`).addEventListener('input', () => {
    const block = selected();
    if (!block || busy) return;
    const value = $(`block-${name}`).value;
    if (['text', 'translated', 'color', 'background'].includes(property)) block[property] = value;
    else if (property === 'fontSize') block.fontSize = clamp(value, 8, 300);
    else if (property === 'opacity') block.opacity = clamp(value, 0, 1);
    else if (property === 'x') block.x = clamp(value, 0, canvas.width - block.width);
    else if (property === 'y') block.y = clamp(value, 0, canvas.height - block.height);
    else if (property === 'width') block.width = clamp(value, 1, canvas.width - block.x);
    else if (property === 'height') block.height = clamp(value, 1, canvas.height - block.y);
    refreshList(); draw();
  });
}
$('block-vertical').addEventListener('change', () => { const block = selected(); if (block) { block.vertical = $('block-vertical').checked; draw(); } });

function canvasPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
}
canvas.addEventListener('pointerdown', event => {
  if (busy) return;
  const point = canvasPosition(event);
  if ($('select-region').checked) { drag = { selecting: true, x: point.x, y: point.y }; canvas.setPointerCapture(event.pointerId); return; }
  const block = [...blocks].reverse().find(item => point.x >= item.x && point.x <= item.x + item.width && point.y >= item.y && point.y <= item.y + item.height);
  selectedId = block?.id;
  if (block) { drag = { id: block.id, x: point.x - block.x, y: point.y - block.y }; canvas.setPointerCapture(event.pointerId); }
  refreshList(); updateEditor(); draw();
});
canvas.addEventListener('pointermove', event => {
  if (!drag || busy) return;
  if (drag.selecting) {
    const point = canvasPosition(event);
    const left = clamp(Math.min(point.x, drag.x), 0, canvas.width - 1);
    const top = clamp(Math.min(point.y, drag.y), 0, canvas.height - 1);
    region = { x: Math.round(left), y: Math.round(top), width: Math.round(clamp(Math.abs(point.x - drag.x), 1, canvas.width - left)), height: Math.round(clamp(Math.abs(point.y - drag.y), 1, canvas.height - top)) };
    $('region-info').textContent = `识别范围：${region.width} × ${region.height}，左上角 ${region.x}, ${region.y}`;
    draw(); return;
  }
  const block = blocks.find(item => item.id === drag.id);
  if (!block) return;
  const point = canvasPosition(event);
  block.x = clamp(point.x - drag.x, 0, canvas.width - block.width);
  block.y = clamp(point.y - drag.y, 0, canvas.height - block.height);
  updateEditor(); draw();
});
canvas.addEventListener('pointerup', () => { drag = undefined; });
canvas.addEventListener('pointercancel', () => { drag = undefined; });
window.addEventListener('resize', () => draw());
window.addEventListener('pagehide', () => { job += 1; operation?.abort(new DOMException('页面已关闭', 'AbortError')); if (worker) worker.terminate(); });

getSettings().then(settings => { if (settings.targetLanguage || settings.target) $('target-language').value = settings.targetLanguage || settings.target; }).catch(error => notice(`无法读取设置：${error.message}`, true));
const initialUrl = new URL(location.href).searchParams.get('image') || new URL(location.href).searchParams.get('url');
if (initialUrl) { $('image-url').value = initialUrl; run(loadImageUrl)(); }
if (new URL(location.href).searchParams.get('capture') === '1') run(async () => {
  const { capturedImage } = await chrome.storage.session.get('capturedImage');
  await chrome.storage.session.remove('capturedImage');
  if (typeof capturedImage !== 'string' || !capturedImage.startsWith('data:image/')) throw new Error('截图缓存为空，请从扩展弹窗重新截图');
  await loadImage(await (await fetch(capturedImage)).blob(), '网页截图.png');
  notice('截图已载入，临时缓存已清除。可拖动框选 OCR 区域，再点击识别。');
})();
