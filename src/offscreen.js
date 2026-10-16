const worker = new Worker(chrome.runtime.getURL('src/network-worker.js'), { type: 'module' });
const waiting = new Map();
worker.onmessage = event => { const callback = waiting.get(event.data.id); if (callback) { waiting.delete(event.data.id); callback(event.data); } };
worker.onerror = () => { for (const [id, callback] of waiting) callback({ id, ok: false, error: '网络 Worker 意外退出，请重新加载扩展。' }); waiting.clear(); };
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url?.includes('/pages/offscreen.html')) return;
  if (message.type === 'networkRequest') { waiting.set(message.id, respond); worker.postMessage(message); return true; }
  if (message.type === 'networkCancel') { worker.postMessage(message); respond({ ok: true }); }
});
