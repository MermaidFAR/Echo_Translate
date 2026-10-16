import { translateTexts, downloadBlob } from './client.js';
import { serializeSubtitles } from './subtitles.js';

export function recordSegment(stream, durationMs, signal) {
  let recorder, timer, aborted = false;
  const promise = new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const tracks = stream.getAudioTracks().filter(track => track.readyState === 'live');
    if (!tracks.length) { reject(new Error('没有可用音轨。共享标签页时请勾选“同时分享标签页音频”。')); return; }
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(new MediaStream(tracks), mimeType ? { mimeType } : {});
    const chunks = [];
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { aborted = true; clean(); if (recorder.state !== 'inactive') recorder.stop(); reject(signal.reason); };
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => { clean(); reject(new Error('浏览器音频录制失败，请重新选择音源。')); };
    recorder.onstop = () => {
      clean(); if (aborted) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      if (!blob.size) reject(new Error('没有录制到音频，请确认音源正在播放。'));
      else resolve(new File([blob], 'live-segment.webm', { type: blob.type }));
    };
    signal?.addEventListener('abort', abort, { once: true });
    recorder.start(); timer = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, durationMs);
  });
  promise.finish = () => { if (recorder?.state === 'recording') recorder.stop(); };
  return promise;
}

export function offsetCues(cues, start) {
  return cues.map(cue => ({ ...cue, start: cue.start + start, end: cue.end + start }));
}

export function initLiveAudio({ transcribe }) {
  const $ = id => document.getElementById(id);
  if (!$('live-start')) return;
  let stream, controller, recording = false, starting = false, segment, processing = false, queue = [], cues = [], startedAt = 0;
  const notice = text => { $('live-status').textContent = text; };
  const update = () => {
    $('live-start').disabled = recording || processing || starting;
    $('live-stop').disabled = !recording;
    $('live-cancel').disabled = !recording && !processing;
    $('live-export').disabled = !cues.length;
  };
  function closeTracks() { stream?.getTracks().forEach(track => track.stop()); stream = undefined; }
  async function overlay(text) {
    const tabId = Number($('live-tab').value);
    if (tabId) {
      try { await chrome.tabs.sendMessage(tabId, { type: 'live-caption', text }); }
      catch { notice('字幕已在本页生成；叠加目标页需刷新并允许扩展访问。'); }
    }
  }
  async function drain() {
    if (processing || !queue.length) return;
    processing = true; update();
    try {
      while (queue.length && !controller.signal.aborted) {
        const job = queue.shift(); notice(`正在识别并翻译音频片段，等待 ${queue.length} 段…`);
        const result = await transcribe(job.file, $('audio-language').value.trim(), controller.signal);
        const translated = await translateTexts(result.cues.map(cue => cue.text), { target: $('audio-target').value.trim() || 'zh-CN',
          source: 'auto', context: '实时音频字幕。保持说话者语气并简洁翻译。', signal: controller.signal });
        const completed = offsetCues(result.cues.map((cue, index) => ({ ...cue, translated: translated[index] })), job.start);
        cues.push(...completed);
        const lines = completed.map(cue => `${cue.text}\n${cue.translated}`).join('\n\n');
        $('live-caption').textContent = lines;
        $('live-transcript').value = cues.map(cue => `${cue.text}\n${cue.translated}`).join('\n\n');
        await overlay(lines);
        notice(recording ? `录制中；已处理 ${cues.length} 条字幕，等待 ${queue.length} 段。` : `已完成 ${cues.length} 条字幕，可导出。`);
      }
    } catch (error) {
      const wasCancelled = controller.signal.aborted;
      controller.abort();
      recording = false; segment?.finish(); closeTracks(); queue = [];
      notice(wasCancelled ? '已取消，保留已完成字幕。' : `实时字幕停止：${error.message}`);
    } finally { processing = false; update(); }
  }
  async function capture() {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('当前浏览器不支持音源共享，请使用桌面版 Chrome。');
    const settings = await chrome.runtime.sendMessage({ type: 'settings' });
    if (!settings.settings?.asrBaseUrl) throw new Error('请先在设置中配置自己的 ASR 服务。');
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include' });
    if (!stream.getAudioTracks().length) { closeTracks(); throw new Error('没有共享音频。请选择正在播放音频的标签页并勾选分享音频。'); }
    controller = new AbortController(); recording = true; cues = []; queue = []; startedAt = performance.now();
    $('live-caption').textContent = ''; $('live-transcript').value = ''; update();
    stream.getVideoTracks()[0]?.addEventListener('ended', () => { recording = false; segment?.finish(); update(); }, { once: true });
    try {
      while (recording && !controller.signal.aborted) {
        const start = (performance.now() - startedAt) / 1000;
        segment = recordSegment(stream, 15000, controller.signal);
        const file = await segment;
        if (controller.signal.aborted) break;
        queue.push({ file, start });
        if (queue.length > 6) { recording = false; notice('ASR 处理落后超过 6 段，已结束录制并处理剩余内容。'); }
        void drain();
      }
    } catch (error) { if (!controller.signal.aborted) notice(error.message); }
    finally { recording = false; segment = undefined; closeTracks(); update(); }
  }
  $('live-start').onclick = () => {
    if (starting || recording || processing) return;
    starting = true; update(); notice('请在浏览器选择音源，并勾选共享音频；每 15 秒提交一段到自己的 ASR。');
    capture().catch(error => { closeTracks(); notice(error.message); }).finally(() => { starting = false; update(); });
  };
  $('live-stop').onclick = () => { recording = false; segment?.finish(); notice('已结束录制，正在处理当前片段和等待队列。'); update(); };
  $('live-cancel').onclick = () => { recording = false; queue = []; controller?.abort(new DOMException('已取消', 'AbortError')); closeTracks(); void overlay(''); update(); };
  $('live-export').onclick = () => downloadBlob(new Blob([serializeSubtitles(cues, 'srt', 'bilingual')], { type: 'text/plain;charset=utf-8' }), 'Echo_Live_Subtitles.srt');
  $('live-refresh-tabs').onclick = async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const option = document.createElement('option'); option.value = ''; option.textContent = '仅在本页显示';
    $('live-tab').replaceChildren(option, ...tabs.filter(tab => /^https?:/.test(tab.url || '')).map(tab => {
      const item = document.createElement('option'); item.value = String(tab.id); item.textContent = tab.title || tab.url; return item;
    }));
  };
  window.addEventListener('pagehide', () => { recording = false; controller?.abort(); closeTracks(); void overlay(''); });
  update();
}
