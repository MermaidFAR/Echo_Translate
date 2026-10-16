const requests = new Map();
self.onmessage = async event => {
  const message = event.data;
  if (message.type === 'networkCancel') { requests.get(message.id)?.abort(); return; }
  const controller = new AbortController(); requests.set(message.id, controller);
  try {
    let body = message.options.body;
    if (body?.formEntries) {
      body = new FormData();
      for (const [key, value] of message.options.body.formEntries) {
        if (typeof value === 'string') body.append(key, value);
        else body.append(key, new Blob([Uint8Array.from(atob(value.base64), character => character.charCodeAt(0))], { type: value.type }), value.name);
      }
    }
    const response = await fetch(message.url, { ...message.options, body, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]) });
    const content = await response.text();
    if (content.length > 16 * 1024 * 1024) throw new Error('API 返回内容过大。');
    self.postMessage({ id: message.id, ok: true, status: response.status, headers: [...response.headers], body: content });
  } catch (error) { self.postMessage({ id: message.id, ok: false, error: error.name === 'AbortError' ? '已取消' : '无法连接网络服务。' }); }
  finally { requests.delete(message.id); }
};
