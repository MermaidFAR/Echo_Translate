let creating;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL('pages/offscreen.html');
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (existing.length) return;
  creating ??= chrome.offscreen.createDocument({ url: 'pages/offscreen.html', reasons: ['WORKERS'],
    justification: '在独立网络 Worker 中完成长时间翻译和语音识别请求，避免后台生命周期中断。' }).finally(() => { creating = null; });
  await creating;
}
function encodeBytes(bytes) {
  let binary = ''; for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary);
}
export async function offscreenFetch(url, options = {}) {
  options.signal?.throwIfAborted(); await ensureOffscreen();
  let body = options.body;
  if (body instanceof FormData) {
    const entries = [];
    for (const [key, value] of body.entries()) entries.push(typeof value === 'string' ? [key, value] :
      [key, { base64: encodeBytes(new Uint8Array(await value.arrayBuffer())), type: value.type, name: value.name }]);
    body = { formEntries: entries };
  }
  options.signal?.throwIfAborted(); const id = crypto.randomUUID();
  let rejectAbort;
  const abortPromise = new Promise((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => { chrome.runtime.sendMessage({ type: 'networkCancel', id }).catch(() => {}); rejectAbort(options.signal.reason); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await Promise.race([abortPromise, chrome.runtime.sendMessage({ type: 'networkRequest', id, url,
      options: { method: options.method || 'GET', headers: options.headers || {}, body, credentials: 'omit' } })]);
    options.signal?.throwIfAborted();
    if (!result?.ok) throw new Error(result?.error || '网络 Worker 未响应。');
    return new Response(result.body, { status: result.status, headers: result.headers });
  } finally { options.signal?.removeEventListener('abort', abort); }
}
