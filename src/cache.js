export class TranslationCache {
  constructor() { this.memory = new Map(); this.pending = null; }
  async database() {
    if (!globalThis.indexedDB) return null;
    this.pending ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('echo-translate', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('translations', { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('无法打开翻译缓存。'));
    });
    return this.pending;
  }
  async get(key, days) {
    const db = await this.database();
    const value = db ? await new Promise((resolve, reject) => {
      const r = db.transaction('translations').objectStore('translations').get(key);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(new Error('读取翻译缓存失败。'));
    }) : this.memory.get(key);
    return value && Date.now() - value.at < days * 86400000 ? value.text : undefined;
  }
  async set(key, text) {
    const value = { key, text, at: Date.now() };
    const db = await this.database();
    if (!db) { this.memory.set(key, value); if (this.memory.size > 2000) this.memory.delete(this.memory.keys().next().value); return; }
    await new Promise((resolve, reject) => {
      const tx = db.transaction('translations', 'readwrite'); const store = tx.objectStore('translations');
      store.put(value);
      const count = store.count();
      count.onsuccess = () => { if (count.result > 10000) store.clear(); };
      tx.oncomplete = resolve; tx.onerror = () => reject(new Error('写入翻译缓存失败。'));
    });
  }
  async clear() {
    this.memory.clear(); const db = await this.database(); if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction('translations', 'readwrite'); tx.objectStore('translations').clear();
      tx.oncomplete = resolve; tx.onerror = () => reject(new Error('清除缓存失败。'));
    });
  }
}
