export async function translateTexts(texts, options = {}) {
  const { signal, ...rest } = options; signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  const abort = () => { chrome.runtime.sendMessage({ type: 'cancel', requestId }).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await chrome.runtime.sendMessage({ type: 'translate', texts, ...rest, requestId });
    signal?.throwIfAborted();
    if (!response?.ok) throw new Error(response?.error || '翻译服务未响应，请重新加载扩展。');
    return response.translations;
  } finally { signal?.removeEventListener('abort', abort); }
}
export async function getSettings() {
  const response = await chrome.runtime.sendMessage({ type: 'settings' });
  if (!response?.ok) throw new Error(response?.error || '无法读取设置。');
  return response.settings;
}
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function showError(element, error) { element.textContent = error?.message || String(error); element.dataset.status = 'error'; }
