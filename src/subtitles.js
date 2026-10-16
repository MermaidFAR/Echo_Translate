const BRIDGE_SOURCE = 'echo-translate-subtitles';
const MAX_CUES = 30000;
const attached = new WeakMap();
const generatedTracks = new WeakSet();

export function parseSubtitleTimestamp(value) {
  const match = String(value).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!match) throw new Error(`无效字幕时间：${value}`);
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) throw new Error(`无效字幕时间：${value}`);
  return hours * 3600 + minutes * 60 + seconds + Number(match[4].padEnd(3, '0')) / 1000;
}

export function formatSubtitleTimestamp(seconds, format = 'srt') {
  const total = Math.max(0, Math.round(Number(seconds) * 1000));
  if (!Number.isFinite(total)) throw new Error('字幕时间必须是有限数值');
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total / 60000) % 60;
  const secs = Math.floor(total / 1000) % 60;
  const millis = total % 1000;
  const separator = format === 'vtt' ? '.' : ',';
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
}

function decodeSubtitleText(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
      if (entity[0] !== '#') return named[entity.toLowerCase()] ?? whole;
      const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : whole;
    }).trim();
}

function normalizeCues(cues) {
  const valid = cues.filter(cue => cue.text.trim() && Number.isFinite(cue.start) && Number.isFinite(cue.end)
    && cue.start >= 0 && cue.end > cue.start).sort((a, b) => a.start - b.start || a.end - b.end);
  if (valid.length > MAX_CUES) throw new Error(`字幕超过 ${MAX_CUES} 条，请分段导入`);
  return valid;
}

export function parseSubtitles(input) {
  if (typeof input !== 'string' || input.length > 8 * 1024 * 1024) throw new Error('字幕必须为小于 8 MB 的文本');
  const blocks = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (/^(WEBVTT|NOTE(?:\s|$)|STYLE$|REGION$)/.test(lines[0] || '')) continue;
    const timeIndex = lines.findIndex(line => line.includes('-->'));
    if (timeIndex < 0) continue;
    const match = lines[timeIndex].match(/^\s*(\S+)\s+-->\s+(\S+)/);
    if (!match) throw new Error(`无效字幕时间行：${lines[timeIndex]}`);
    const start = parseSubtitleTimestamp(match[1]);
    const end = parseSubtitleTimestamp(match[2]);
    if (end <= start) throw new Error('字幕结束时间必须晚于开始时间');
    const text = decodeSubtitleText(lines.slice(timeIndex + 1).join('\n'));
    cues.push({ start, end, text, translated: '' });
  }
  const result = normalizeCues(cues);
  if (!result.length) throw new Error('没有找到可用的 SRT / WebVTT 字幕');
  return result;
}

export function parseYoutubeCaptionResponse(input) {
  const value = input.trim();
  if (value.startsWith('{')) {
    const parsed = JSON.parse(value);
    return normalizeCues((parsed.events || []).filter(event => Array.isArray(event.segs)).map(event => ({
      start: Number(event.tStartMs) / 1000,
      end: (Number(event.tStartMs) + Number(event.dDurationMs || 3000)) / 1000,
      text: event.segs.map(segment => segment.utf8 || '').join('').trim(),
      translated: '',
    })));
  }
  const cues = [];
  const tags = /<(text|p)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  for (const match of value.matchAll(tags)) {
    const attributes = Object.fromEntries([...match[2].matchAll(/([\w-]+)=["']([^"']*)["']/g)].map(item => [item[1], item[2]]));
    const milliseconds = match[1] === 'p';
    const start = Number(attributes[milliseconds ? 't' : 'start']);
    const duration = Number(attributes[milliseconds ? 'd' : 'dur'] || (milliseconds ? 3000 : 3));
    cues.push({ start: start / (milliseconds ? 1000 : 1), end: (start + duration) / (milliseconds ? 1000 : 1), text: decodeSubtitleText(match[3]), translated: '' });
  }
  return normalizeCues(cues);
}

export function serializeSubtitles(cues, format = 'srt', mode = 'bilingual') {
  if (!['srt', 'vtt'].includes(format)) throw new Error('仅支持 SRT 和 WebVTT 导出');
  const body = normalizeCues(cues).map((cue, index) => {
    let text = cue.text;
    if (mode === 'translation') text = cue.translated || cue.text;
    else if (mode === 'bilingual' && cue.translated && cue.translated !== cue.text) text += `\n${cue.translated}`;
    const line = `${formatSubtitleTimestamp(cue.start, format)} --> ${formatSubtitleTimestamp(cue.end, format)}\n${text}`;
    return format === 'srt' ? `${index + 1}\n${line}` : line;
  }).join('\n\n');
  return `${format === 'vtt' ? 'WEBVTT\n\n' : ''}${body}\n`;
}

export function getActiveSubtitleCues(cues, time, offset = 0) {
  const position = time + offset;
  return cues.filter(cue => cue.start <= position && position < cue.end);
}

function getYoutubeTracks() {
  if (!/(^|\.)youtube(?:-nocookie)?\.com$/i.test(location.hostname)) return Promise.resolve([]);
  return new Promise(resolve => {
    const nonce = crypto.randomUUID();
    const timer = setTimeout(() => finish([]), 2500);
    const receive = event => {
      if (event.source !== window || event.data?.source !== BRIDGE_SOURCE || event.data?.type !== 'tracks' || event.data?.nonce !== nonce) return;
      const tracks = Array.isArray(event.data.tracks) ? event.data.tracks.slice(0, 100) : [];
      finish(tracks.filter(track => {
        try { const url = new URL(track.url); return url.protocol === 'https:' && /(^|\.)youtube(?:-nocookie)?\.com$/.test(url.hostname) && url.pathname === '/api/timedtext'; }
        catch { return false; }
      }).map((track, index) => ({ id: `youtube-${index}`, kind: 'youtube', label: String(track.label || track.language || 'YouTube 字幕').slice(0, 200), language: String(track.language || '').slice(0, 30), url: track.url })));
    };
    function finish(tracks) { clearTimeout(timer); window.removeEventListener('message', receive); resolve(tracks); }
    window.addEventListener('message', receive);
    window.postMessage({ source: BRIDGE_SOURCE, type: 'request', nonce }, location.origin);
  });
}

async function readNativeTrack(video, source) {
  const track = source.track;
  const previousMode = track.mode;
  track.mode = 'hidden';
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (track.cues?.length) return normalizeCues(Array.from(track.cues, cue => ({ start: cue.startTime, end: cue.endTime, text: decodeSubtitleText(cue.text || ''), translated: '' })));
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const element = [...video.querySelectorAll('track')].find(item => item.track === track);
    if (element?.src) {
      const response = await chrome.runtime.sendMessage({ type: 'fetchSubtitle', url: element.src, pageUrl: location.href });
      if (!response?.ok) throw new Error(response?.error || '字幕下载失败');
      return parseSubtitles(response.text);
    }
    throw new Error('该轨道尚未提供完整字幕；请启用网站字幕后刷新，或导入字幕文件');
  } finally { track.mode = previousMode; }
}

export function attachSubtitles(video, options = {}) {
  if (attached.has(video)) return attached.get(video);
  const root = document.createElement('div');
  root.dataset.echoSubtitles = 'true';
  root.dataset.echoOwned = 'true';
  const shadow = root.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{all:initial;position:fixed;z-index:2147483646;pointer-events:none;font:13px/1.5 system-ui,sans-serif;color:#172637}
    *{box-sizing:border-box}button,input,select{font:inherit}button,select,input{border:1px solid #becad5;border-radius:6px;padding:5px 8px;background:#fff;color:#172637}
    button{cursor:pointer}button:disabled{opacity:.5;cursor:default}.toggle{position:absolute;top:8px;left:8px;pointer-events:auto;background:#183e57;color:#fff;border:0}
    .panel{position:absolute;top:44px;left:8px;width:min(390px,calc(100vw - 24px));padding:12px;max-height:65vh;overflow:auto;pointer-events:auto;background:#f7fafc;box-shadow:0 5px 28px #0005;border-radius:10px;border:1px solid #bacad8}
    .row{display:flex;gap:6px;flex-wrap:wrap;margin:7px 0;align-items:center}.row select{flex:1;min-width:0}.target{width:85px}.status{white-space:pre-wrap;font-size:12px;color:#41576b}.caption{position:absolute;bottom:8%;left:5%;width:90%;text-align:center;white-space:pre-line;font-size:clamp(16px,2.2vw,28px);font-weight:600;color:#fff;text-shadow:0 1px 4px #000,0 0 3px #000}
    .caption>div{background:#000a;display:table;margin:3px auto;padding:3px 9px;border-radius:4px}.translation{color:#f4edb9}.hint{font-size:12px;color:#566a7c}label{display:flex;gap:5px;align-items:center}.offset{width:75px}[hidden]{display:none!important}
  </style><button class="toggle" type="button">双语字幕</button><section class="panel" hidden>
    <strong>已有字幕翻译</strong><div class="row"><select aria-label="字幕轨道"></select><button class="refresh" type="button">刷新轨道</button></div>
    <div class="row"><button class="load" type="button">读取字幕</button><label>目标语言 <input class="target" value="zh-CN" aria-label="字幕目标语言"></label><button class="translate" type="button">翻译</button><button class="stop" type="button" hidden>停止</button></div>
    <div class="row"><label>导入 SRT / VTT <input class="file" type="file" accept=".srt,.vtt,text/vtt" style="max-width:215px"></label></div>
    <div class="row"><label><input class="enabled" type="checkbox" checked>显示双语</label><label>时间偏移（秒）<input class="offset" type="number" value="0" step="0.1" min="-600" max="600"></label></div>
    <div class="row"><select class="export-mode" aria-label="导出内容"><option value="bilingual">双语</option><option value="translation">仅译文</option><option value="source">仅原文</option></select><button class="srt" type="button">导出 SRT</button><button class="vtt" type="button">导出 VTT</button></div>
    <div class="status" role="status">打开面板后发现页面提供的字幕。</div><p class="hint">支持网页原生字幕、YouTube 已有字幕及手动导入。本工程的 DeepSeek 文本接口不提供语音识别；无字幕音频与实时共享音频可在扩展音频页连接自己的 ASR 服务。</p>
  </section><div class="caption" hidden><div class="source"></div><div class="translation"></div></div>`;
  document.documentElement.append(root);
  const query = selector => shadow.querySelector(selector);
  const panel = query('.panel');
  const select = query('select');
  const status = query('.status');
  const target = query('.target');
  target.value = options.target || 'zh-CN';
  const caption = query('.caption');
  let cues = [];
  let tracks = [];
  let offset = 0;
  let generation = 0;
  let translating = false;
  let translationController;
  let nativeOverlayTrack;
  let destroyed = false;
  let lastCaption = '';
  const notice = value => { status.textContent = value; };

  function positionOverlay() {
    if (destroyed) return;
    const rect = video.getBoundingClientRect();
    root.style.left = `${rect.left}px`;
    root.style.top = `${rect.top}px`;
    root.style.width = `${rect.width}px`;
    root.style.height = `${rect.height}px`;
    root.hidden = rect.width < 120 || rect.height < 70 || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth;
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen !== video && fullscreen.contains(video) ? fullscreen : document.documentElement;
    if (root.parentElement !== parent) parent.append(root);
    if (nativeOverlayTrack) nativeOverlayTrack.mode = fullscreen === video && query('.enabled').checked ? 'showing' : 'hidden';
    showCurrentCue();
  }

  function showCurrentCue() {
    const active = getActiveSubtitleCues(cues, video.currentTime, offset);
    const sourceText = active.map(cue => cue.text).join('\n');
    const translationText = active.map(cue => cue.translated || '').filter(Boolean).join('\n');
    const signature = `${sourceText}\u0000${translationText}`;
    caption.hidden = !query('.enabled').checked || !sourceText || document.fullscreenElement === video;
    if (signature === lastCaption) return;
    lastCaption = signature;
    query('.source').textContent = sourceText;
    query('.translation').textContent = translationText;
    query('.translation').hidden = !translationText;
  }

  function updateNativeOverlay() {
    if (typeof VTTCue === 'undefined') return;
    nativeOverlayTrack ||= video.addTextTrack('subtitles', 'Echo 双语', target.value || 'zh-CN');
    generatedTracks.add(nativeOverlayTrack);
    for (const cue of Array.from(nativeOverlayTrack.cues || [])) nativeOverlayTrack.removeCue(cue);
    for (const cue of cues) {
      const start = Math.max(0, cue.start - offset);
      const end = cue.end - offset;
      if (end <= start) continue;
      nativeOverlayTrack.addCue(new VTTCue(start, end, `${cue.text}${cue.translated ? `\n${cue.translated}` : ''}`));
    }
    nativeOverlayTrack.mode = document.fullscreenElement === video && query('.enabled').checked ? 'showing' : 'hidden';
  }

  function replaceCues(value) {
    generation += 1;
    translationController?.abort(new DOMException('字幕已替换', 'AbortError'));
    cues = value;
    lastCaption = '';
    updateNativeOverlay();
    showCurrentCue();
    notice(`已读取 ${cues.length} 条字幕。点击翻译将字幕文本发送到你配置的 API。`);
  }

  async function refresh() {
    notice('正在发现页面字幕…');
    tracks = Array.from(video.textTracks || []).filter(track => !generatedTracks.has(track) && ['subtitles', 'captions'].includes(track.kind))
      .map((track, index) => ({ id: `native-${index}`, kind: 'native', label: track.label || track.language || `原生轨道 ${index + 1}`, language: track.language, track }));
    tracks.push(...await getYoutubeTracks());
    select.replaceChildren();
    for (const track of tracks) { const item = document.createElement('option'); item.value = track.id; item.textContent = `${track.label} · ${track.kind === 'youtube' ? 'YouTube' : '原生'}`; select.append(item); }
    if (!tracks.length) { const item = document.createElement('option'); item.textContent = '未发现字幕；可导入 SRT / VTT'; select.append(item); }
    notice(tracks.length ? `发现 ${tracks.length} 个轨道，选择后读取。` : '未发现已有字幕。请先打开网站字幕，或导入本地字幕；无字幕视频需另接 ASR。');
    return tracks;
  }

  async function loadSelected() {
    const source = tracks.find(track => track.id === select.value);
    if (!source) throw new Error('请选择可用字幕轨道，或导入 SRT / VTT 文件');
    notice('正在读取字幕…');
    let result;
    if (source.kind === 'native') result = await readNativeTrack(video, source);
    else {
      const url = new URL(source.url);
      url.searchParams.set('fmt', 'json3');
      const response = await chrome.runtime.sendMessage({ type: 'fetchSubtitle', url: url.href, pageUrl: location.href });
      if (!response?.ok) throw new Error(response?.error || 'YouTube 字幕下载失败');
      result = parseYoutubeCaptionResponse(response.text);
    }
    if (!result.length) throw new Error('网站返回空字幕；请启用字幕并刷新后重试，或手动导入');
    replaceCues(result);
    return result;
  }

  async function translate() {
    if (translating) return;
    if (!cues.length) throw new Error('请先读取或导入字幕');
    translating = true;
    translationController = new AbortController();
    const controller = translationController;
    const current = ++generation;
    const unique = [...new Set(cues.filter(cue => !cue.translated).map(cue => cue.text))];
    query('.stop').hidden = false;
    query('.translate').disabled = true;
    try {
      const translateTexts = options.translateTexts || (await import('./client.js')).translateTexts;
      for (let index = 0; index < unique.length; index += 30) {
        if (current !== generation || destroyed) break;
        const batch = unique.slice(index, index + 30);
        notice(`正在翻译 ${index + 1}–${Math.min(index + batch.length, unique.length)} / ${unique.length} 段字幕…`);
        const translated = await translateTexts(batch, { source: options.source || 'auto', target: target.value.trim() || 'zh-CN', context: '视频字幕。保持每条字幕简洁，保留说话者语气与专有名词。', mode: 'translate', signal: controller.signal });
        if (current !== generation || destroyed) break;
        if (!Array.isArray(translated) || translated.length !== batch.length) throw new Error('翻译结果数量与字幕不一致');
        const mapping = new Map(batch.map((text, item) => [text, translated[item]]));
        for (const cue of cues) if (mapping.has(cue.text)) cue.translated = mapping.get(cue.text);
        lastCaption = '';
        showCurrentCue();
      }
      updateNativeOverlay();
      notice(current === generation ? `翻译完成，共 ${cues.length} 条字幕。可播放查看并导出。` : '已停止后续翻译，保留已完成结果。');
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      notice('已停止字幕翻译，保留已经完成的结果。');
    } finally { translating = false; if (translationController === controller) translationController = undefined; query('.stop').hidden = true; query('.translate').disabled = false; }
  }

  function run(action) { return (...args) => Promise.resolve().then(() => action(...args)).catch(error => notice(error.message || String(error))); }
  query('.toggle').addEventListener('click', run(async () => { panel.hidden = !panel.hidden; if (!panel.hidden && !tracks.length) await refresh(); }));
  query('.refresh').addEventListener('click', run(refresh));
  query('.load').addEventListener('click', run(loadSelected));
  query('.translate').addEventListener('click', run(translate));
  query('.stop').addEventListener('click', () => { generation += 1; translationController?.abort(new DOMException('已取消', 'AbortError')); notice('正在停止字幕翻译…'); });
  query('.file').addEventListener('change', run(async event => {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) throw new Error('字幕文件不能超过 8 MB');
    replaceCues(parseSubtitles(await file.text()));
  }));
  query('.enabled').addEventListener('change', positionOverlay);
  query('.offset').addEventListener('change', () => { offset = Number(query('.offset').value) || 0; updateNativeOverlay(); showCurrentCue(); });
  const exportFile = async format => {
    if (!cues.length) throw new Error('没有可导出的字幕');
    const { downloadBlob } = await import('./client.js');
    const text = serializeSubtitles(cues, format, query('.export-mode').value);
    downloadBlob(new Blob([text], { type: format === 'vtt' ? 'text/vtt;charset=utf-8' : 'text/plain;charset=utf-8' }), `echo-subtitles.${format}`);
  };
  query('.srt').addEventListener('click', run(() => exportFile('srt')));
  query('.vtt').addEventListener('click', run(() => exportFile('vtt')));
  video.addEventListener('timeupdate', showCurrentCue);
  document.addEventListener('fullscreenchange', positionOverlay);
  window.addEventListener('resize', positionOverlay);
  const timer = setInterval(positionOverlay, 200);
  positionOverlay();
  const controller = {
    refresh, loadSelected, translate,
    importText(text) { replaceCues(parseSubtitles(text)); return cues; },
    getCues() { return cues.map(cue => ({ ...cue })); },
    show() { panel.hidden = false; return refresh(); },
    hide() { panel.hidden = true; },
    destroy() {
      destroyed = true;
      generation += 1;
      translationController?.abort(new DOMException('视频已移除', 'AbortError'));
      clearInterval(timer);
      video.removeEventListener('timeupdate', showCurrentCue);
      document.removeEventListener('fullscreenchange', positionOverlay);
      window.removeEventListener('resize', positionOverlay);
      if (nativeOverlayTrack) { nativeOverlayTrack.mode = 'disabled'; for (const cue of Array.from(nativeOverlayTrack.cues || [])) nativeOverlayTrack.removeCue(cue); }
      root.remove();
      attached.delete(video);
    },
  };
  attached.set(video, controller);
  return controller;
}

export function initSubtitles(options = {}) {
  const controllers = new Map();
  const scan = () => {
    for (const [video, controller] of controllers) if (!video.isConnected) { controller.destroy(); controllers.delete(video); }
    for (const video of document.querySelectorAll('video')) if (!controllers.has(video)) controllers.set(video, attachSubtitles(video, options));
  };
  scan();
  const observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return { refresh: scan, destroy() { observer.disconnect(); for (const controller of controllers.values()) controller.destroy(); controllers.clear(); } };
}
