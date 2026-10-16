import { DEFAULTS, normalizeSettings, resolveEndpoint } from './settings.js';
import { DeepSeekClient } from './api.js';
import { TranslationCache } from './cache.js';
import { offscreenFetch } from './transport.js';

const cache = new TranslationCache();
const requests = new Map();
const cancelled = new Map();
let client, revision = '';
async function configuration() {
  const stored = await chrome.storage.local.get(['settings', 'apiKey']);
  return { settings: normalizeSettings(stored.settings), apiKey: stored.apiKey || '' };
}
function senderKey(sender, id) { return `${sender.tab?.id ?? 'extension'}:${sender.frameId ?? 0}:${id}`; }
function registerRequest(key, controller) {
  const now = Date.now();
  for (const [id, at] of cancelled) if (now - at > 60000) cancelled.delete(id);
  if (cancelled.has(key)) { cancelled.delete(key); throw new DOMException('已取消', 'AbortError'); }
  requests.set(key, controller);
}
function requireExtensionPage(sender) {
  if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('此操作仅供扩展页面使用。');
}
async function translate(message, sender) {
  const config = await configuration();
  const stamp = JSON.stringify(config);
  if (stamp !== revision) { client = new DeepSeekClient(config.settings, config.apiKey, { cache, fetchImpl: offscreenFetch }); revision = stamp; }
  const controller = new AbortController(); const key = senderKey(sender, message.requestId);
  registerRequest(key, controller);
  const heartbeat = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    const translations = await client.translate(message.texts, { source: message.source || config.settings.source,
      target: message.target || config.settings.target, context: message.context || '', mode: message.mode || 'translate',
      instruction: message.instruction || '', signal: controller.signal });
    return { translations };
  } finally { clearInterval(heartbeat); if (requests.get(key) === controller) requests.delete(key); }
}
async function fetchResource(message, sender) {
  const url = new URL(message.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('资源地址无效。');
  if (message.type === 'fetchSubtitle') {
    const pageOrigin = sender.tab?.url ? new URL(sender.tab.url).origin : '';
    if (!(url.origin === pageOrigin || /(^|\.)youtube\.com$/.test(url.hostname) || /(^|\.)googlevideo\.com$/.test(url.hostname))) {
      throw new Error('字幕地址不属于当前页面或受支持的视频字幕来源。');
    }
  }
  const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`资源读取失败（HTTP ${response.status}）。`);
  const max = message.type === 'fetchImage' ? 25 * 1024 * 1024 : 5 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > max) throw new Error('资源文件过大。');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length;
    if (size > max) { await reader.cancel(); throw new Error('资源文件过大。'); } chunks.push(value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  if (message.type === 'fetchSubtitle') return { text: new TextDecoder().decode(bytes) };
  const mime = response.headers.get('content-type')?.split(';')[0] || '';
  if (!/^image\/(png|jpe?g|webp|gif|bmp|avif)$/.test(mime)) throw new Error('仅支持普通位图图片，请下载后在图片页导入。');
  let binary = ''; for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return { dataUrl: `data:${mime};base64,${btoa(binary)}` };
}
async function transcribe(message, sender) {
  requireExtensionPage(sender);
  const { settings } = await configuration();
  if (!settings.asrBaseUrl.trim()) throw new Error('请先配置自己的语音识别 API。DeepSeek 文本 API 不提供此接口。');
  const configured = settings.asrBaseUrl.replace(/\/audio\/transcriptions\/?$/, '');
  const endpoint = resolveEndpoint(configured).replace(/\/chat\/completions$/, '/audio/transcriptions');
  const { asrApiKey = '' } = await chrome.storage.local.get('asrApiKey');
  if (typeof message.audioBase64 !== 'string' || message.audioBase64.length > 28 * 1024 * 1024) throw new Error('音频文件过大或数据无效（上限 20 MiB）。');
  const binary = atob(message.audioBase64);
  if (binary.length > 20 * 1024 * 1024) throw new Error('音频文件超过 20 MiB。');
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const body = new FormData(); body.append('model', settings.asrModel || 'whisper-1'); body.append('response_format', 'srt');
  body.append('file', new Blob([bytes], { type: String(message.mime || 'application/octet-stream') }), String(message.fileName || 'audio.wav').slice(0, 200));
  if (typeof message.language === 'string' && /^[a-z]{2,3}(?:-[A-Za-z]+)?$/.test(message.language)) body.append('language', message.language);
  const controller = new AbortController(); const key = senderKey(sender, message.requestId); registerRequest(key, controller);
  const heartbeat = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    const response = await offscreenFetch(endpoint, { method: 'POST', credentials: 'omit', body,
      headers: asrApiKey ? { Authorization: `Bearer ${asrApiKey}` } : {},
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]) });
    if (!response.ok) throw new Error(`语音识别失败（HTTP ${response.status}），请检查 ASR 地址、密钥、模型和音频格式。`);
    const text = await response.text(); if (text.length > 8 * 1024 * 1024) throw new Error('ASR 返回字幕过大。');
    if (!/\d{2}:\d{2}.*-->/.test(text)) throw new Error('ASR 没有返回 SRT 时间轴字幕，请确认服务支持 response_format=srt。');
    return { text, format: 'srt' };
  } finally { clearInterval(heartbeat); requests.delete(key); }
}
async function handle(message, sender) {
  switch (message.type) {
    case 'settings': { const { settings, apiKey } = await configuration(); return { settings: { ...settings, hasKey: !!apiKey } }; }
    case 'translate': return translate(message, sender);
    case 'transcribe': return transcribe(message, sender);
    case 'cancel': {
      const key = senderKey(sender, message.requestId); const request = requests.get(key);
      if (request) request.abort(new DOMException('已取消', 'AbortError'));
      else { if (cancelled.size > 100) cancelled.delete(cancelled.keys().next().value); cancelled.set(key, Date.now()); }
      return {};
    }
    case 'clearCache': requireExtensionPage(sender); await cache.clear(); return {};
    case 'fetchImage': case 'fetchSubtitle': return fetchResource(message, sender);
    case 'captureViewport': {
      requireExtensionPage(sender);
      const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
      await chrome.storage.session.set({ capturedImage: dataUrl });
      await chrome.tabs.create({ url: chrome.runtime.getURL('pages/media.html?capture=1') }); return {};
    }
    case 'models': {
      requireExtensionPage(sender); const config = await configuration();
      const url = new URL(resolveEndpoint(config.settings.baseUrl)); url.pathname = url.pathname.replace(/\/chat\/completions$/, '/models');
      const response = await fetch(url, { headers: { Authorization: `Bearer ${config.apiKey}` }, credentials: 'omit', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`模型列表读取失败（HTTP ${response.status}）。`);
      const data = await response.json(); return { models: (data.data || []).map(x => x.id).filter(x => typeof x === 'string') };
    }
    default: throw new Error('未知扩展请求。');
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'networkRequest' || message.type === 'networkCancel') return;
  handle(message, sender).then(value => respond({ ok: true, ...value }), error => respond({ ok: false, error: error.name === 'AbortError' ? '已取消' : error.message || '操作失败。' }));
  return true;
});
async function sendTab(type, extra = {}, tabId) {
  const tab = tabId ? { id: tabId } : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id) return;
  try { await chrome.tabs.sendMessage(tab.id, { type, ...extra }); }
  catch { await chrome.action.setBadgeText({ tabId: tab.id, text: '!' }); await chrome.action.setTitle({ tabId: tab.id, title: '此页面无法注入翻译脚本；普通网页请刷新后重试。' }); }
}
function createMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const [id, title, contexts] of [
      ['translate-page', 'Echo：翻译 / 恢复网页', ['page']], ['translate-selection', 'Echo：翻译选中文字', ['selection']],
      ['explain-selection', 'Echo：解释选中文字', ['selection']], ['translate-input', 'Echo：翻译输入框', ['editable']],
      ['translate-image', 'Echo：识别并翻译图片', ['image']], ['translate-subtitles', 'Echo：双语视频字幕', ['video', 'page']],
      ['open-documents', 'Echo：翻译文件 / PDF / 电子书', ['page']]]) chrome.contextMenus.create({ id, title, contexts });
  });
}
chrome.runtime.onInstalled.addListener(async () => {
  createMenus(); const data = await chrome.storage.local.get('settings');
  if (!data.settings) { await chrome.storage.local.set({ settings: DEFAULTS }); await chrome.runtime.openOptionsPage(); }
});
chrome.runtime.onStartup.addListener(createMenus);
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'translate-image') chrome.tabs.create({ url: chrome.runtime.getURL(`pages/media.html?image=${encodeURIComponent(info.srcUrl)}`) });
  else if (info.menuItemId === 'open-documents') chrome.tabs.create({ url: chrome.runtime.getURL('pages/documents.html') });
  else sendTab(info.menuItemId, { text: info.selectionText }, tab.id);
});
chrome.commands.onCommand.addListener(async command => {
  if (command === 'open-panel') { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab?.id) await chrome.sidePanel.open({ tabId: tab.id }); }
  else await sendTab(command);
});
