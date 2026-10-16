import { getSettings, translateTexts, downloadBlob } from './client.js';
import { parseSubtitles, serializeSubtitles, getActiveSubtitleCues } from './subtitles.js';
import { initLiveAudio } from './live-audio.js';

export const MAX_AUDIO_SIZE = 20 * 1024 * 1024;

export function validateAudioFile(file) {
  if (!file || !Number.isFinite(file.size) || file.size <= 0) throw new Error('请选择非空音频 / 视频文件');
  if (file.size > MAX_AUDIO_SIZE) throw new Error('文件不能超过 20 MiB，请先压缩或分段导出音频');
  if (!/\.(mp3|m4a|mp4|mpeg|mpga|wav|webm|ogg|flac|aac|opus)$/i.test(file.name || '') && !/^(audio\/|video\/(mp4|webm))/.test(file.type || '')) throw new Error('请选择 MP3、M4A、MP4、WAV、WebM、OGG 或 FLAC 等音频文件');
  return file;
}

export function parseTranscriptionResponse(response) {
  if (!response?.ok) throw new Error(response?.error || 'ASR 服务没有返回结果');
  if (typeof response.text !== 'string') throw new Error('ASR 返回内容不是字幕文本');
  return parseSubtitles(response.text);
}

function readFileAsBase64(file, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const reader = new FileReader();
    const abort = () => reader.abort();
    const clean = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    reader.onload = () => { clean(); resolve(String(reader.result).split(',')[1]); };
    reader.onerror = () => { clean(); reject(reader.error || new Error('无法读取音频文件')); };
    reader.onabort = () => { clean(); reject(new DOMException('已取消', 'AbortError')); };
    reader.readAsDataURL(file);
  });
}

async function transcribeFile(file, language, signal) {
  validateAudioFile(file);
  const audioBase64 = await readFileAsBase64(file, signal);
  signal.throwIfAborted();
  const requestId = crypto.randomUUID();
  const cancel = () => chrome.runtime.sendMessage({ type: 'cancel', requestId }).catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const response = await chrome.runtime.sendMessage({ type: 'transcribe', audioBase64, fileName: file.name, mime: file.type || 'application/octet-stream', language, requestId });
    signal.throwIfAborted();
    return { response, cues: parseTranscriptionResponse(response) };
  } finally { signal.removeEventListener('abort', cancel); }
}

export function initAudioPage() {
  const $ = id => document.getElementById(id);
  const style = document.createElement('style');
  style.textContent = `#audio-page{max-width:1280px;margin:auto;padding:28px;color:#172637}#audio-page header{margin-bottom:22px}#audio-page h1{margin-bottom:8px}#audio-page header p{color:#52687c}#audio-page h2{font-size:18px;margin:0 0 8px}.audio-card{background:white;border:1px solid #d4dfe7;padding:20px;border-radius:12px;margin-bottom:18px}.audio-row{display:flex;align-items:center;flex-wrap:wrap;gap:14px;margin:12px 0}.audio-row label{display:flex;gap:6px;align-items:center}.audio-row input:not([type=file]){width:130px}.audio-note{font-size:13px;line-height:1.6;color:#52687c}.audio-columns{display:grid;grid-template-columns:1fr 1fr;gap:18px}.audio-columns textarea{width:100%;box-sizing:border-box;resize:vertical;font:13px/1.65 ui-monospace,Consolas,monospace}#audio-player{width:100%;margin:12px 0}#audio-caption{white-space:pre-line;text-align:center;background:#172637;color:#fff;border-radius:8px;font-size:20px;padding:12px;min-height:60px}#audio-caption:empty{display:none}#audio-status{white-space:pre-wrap}#audio-status.error{color:#b12a38}#audio-page button:disabled{opacity:.5;cursor:default}#audio-page button{cursor:pointer}@media(max-width:800px){.audio-columns{grid-template-columns:1fr}#audio-page{padding:16px}.audio-row label{flex-wrap:wrap}}`;
  document.head.append(style);
  let audioFile;
  let audioUrl;
  let cues = [];
  let controller;
  let sourceRevision = '';
  const player = $('audio-player');
  const status = $('audio-status');
  const notice = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
  const updateButtons = () => {
    $('audio-transcribe').disabled = !!controller || !audioFile;
    $('audio-translate').disabled = !!controller || !$('audio-source').value.trim();
    $('audio-file').disabled = !!controller;
    $('audio-source').readOnly = !!controller;
    $('audio-cancel').hidden = !controller;
    for (const format of ['srt', 'vtt']) $(`audio-export-${format}`).disabled = !!controller || !cues.length;
  };
  function renderPreview() {
    $('audio-preview').value = cues.length ? serializeSubtitles(cues, 'srt', 'bilingual') : '';
    const active = getActiveSubtitleCues(cues, player.currentTime || 0);
    $('audio-caption').textContent = active.map(cue => `${cue.text}${cue.translated ? `\n${cue.translated}` : ''}`).join('\n');
  }
  function readSource() {
    const value = $('audio-source').value;
    if (value !== sourceRevision) { cues = parseSubtitles(value); sourceRevision = value; renderPreview(); }
    return cues;
  }
  async function perform(action) {
    if (controller) return;
    const current = new AbortController();
    controller = current;
    updateButtons();
    try { await action(current.signal); }
    catch (error) { notice(current.signal.aborted ? '操作已取消，保留已经完成的结果。' : error.message || String(error), !current.signal.aborted); }
    finally { if (controller === current) controller = undefined; updateButtons(); }
  }
  $('audio-file').addEventListener('change', () => {
    try {
      const file = validateAudioFile($('audio-file').files[0]);
      audioFile = file;
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(file);
      player.src = audioUrl;
      player.hidden = false;
      cues = [];
      sourceRevision = '';
      $('audio-source').value = '';
      renderPreview();
      notice(`已选择 ${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MiB）。点击“生成字幕”会上传音频到独立 ASR 服务。`);
    } catch (error) { audioFile = undefined; notice(error.message, true); }
    updateButtons();
  });
  $('audio-transcribe').addEventListener('click', () => perform(async signal => {
    if (!audioFile) throw new Error('请先选择音频文件');
    notice('正在读取文件并上传到你配置的 ASR 服务，等待带时间的字幕…');
    const result = await transcribeFile(audioFile, $('audio-language').value.trim(), signal);
    cues = result.cues;
    $('audio-source').value = serializeSubtitles(cues, result.response.format === 'vtt' ? 'vtt' : 'srt', 'source');
    sourceRevision = $('audio-source').value;
    renderPreview();
    notice(`转写完成，共 ${cues.length} 条带时间的字幕。可修改原文，然后翻译或导出。`);
  }));
  $('audio-translate').addEventListener('click', () => perform(async signal => {
    readSource();
    const unique = [...new Set(cues.filter(cue => !cue.translated).map(cue => cue.text))];
    for (let index = 0; index < unique.length; index += 30) {
      signal.throwIfAborted();
      const batch = unique.slice(index, index + 30);
      notice(`正在翻译 ${index + 1}–${Math.min(index + 30, unique.length)} / ${unique.length} 段字幕…`);
      const translated = await translateTexts(batch, { source: 'auto', target: $('audio-target').value.trim() || 'zh-CN', context: '音频字幕。请保持说话者语气，译文简洁自然，保留专有名词。', mode: 'translate', signal });
      if (!Array.isArray(translated) || translated.length !== batch.length) throw new Error('翻译结果数量与字幕不一致');
      const mapping = new Map(batch.map((text, item) => [text, translated[item]]));
      for (const cue of cues) if (mapping.has(cue.text)) cue.translated = mapping.get(cue.text);
      renderPreview();
    }
    notice(`翻译完成，共 ${cues.length} 条字幕。可播放音频查看同步效果，或导出 SRT / VTT。`);
  }));
  $('audio-cancel').addEventListener('click', () => { controller?.abort(new DOMException('已取消', 'AbortError')); notice('正在取消当前请求…'); });
  $('audio-source').addEventListener('input', () => { $('audio-translate').disabled = !!controller || !$('audio-source').value.trim(); });
  $('audio-source').addEventListener('change', () => { try { readSource(); updateButtons(); } catch (error) { notice(error.message, true); } });
  for (const format of ['srt', 'vtt']) $(`audio-export-${format}`).addEventListener('click', () => {
    try {
      readSource();
      const baseName = (audioFile?.name || 'audio').replace(/\.[^.]+$/, '');
      downloadBlob(new Blob([serializeSubtitles(cues, format, $('audio-export-mode').value)], { type: format === 'vtt' ? 'text/vtt;charset=utf-8' : 'text/plain;charset=utf-8' }), `${baseName}-subtitles.${format}`);
    } catch (error) { notice(error.message, true); }
  });
  player.addEventListener('timeupdate', () => { const active = getActiveSubtitleCues(cues, player.currentTime); $('audio-caption').textContent = active.map(cue => `${cue.text}${cue.translated ? `\n${cue.translated}` : ''}`).join('\n'); });
  window.addEventListener('pagehide', () => { controller?.abort(new DOMException('页面已关闭', 'AbortError')); if (audioUrl) URL.revokeObjectURL(audioUrl); });
  getSettings().then(settings => {
    $('audio-target').value = settings.target || settings.targetLanguage || 'zh-CN';
    $('audio-config').textContent = settings.asrBaseUrl ? `独立 ASR 地址：${settings.asrBaseUrl} · 模型：${settings.asrModel || 'whisper-1'}` : '尚未配置独立 ASR 服务，请先在 API 设置中填写转写服务地址、模型和独立密钥。';
  }).catch(error => notice(error.message, true));
  updateButtons();
  initLiveAudio({ transcribe: transcribeFile });
}

if (typeof document !== 'undefined' && document.getElementById('audio-page')) initAudioPage();
