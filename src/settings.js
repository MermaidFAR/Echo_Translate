export const DEFAULTS = Object.freeze({
  baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', source: 'auto', target: 'zh-CN',
  displayMode: 'bilingual', concurrency: 3, batchSize: 4, maxChars: 2400,
  temperature: 0.1, timeout: 120000, retries: 2, thinking: false,
  glossary: '', systemPrompt: '', autoTranslate: false, sites: [], excludedSites: [],
  hoverEnabled: false, selectionPopup: true, showButton: true,
  cacheEnabled: true, cacheDays: 7, fontSize: 16, color: '#147d68',
  translationStyle: 'natural',
  translationIndicator: 'line',
  asrBaseUrl: '', asrModel: 'whisper-1',
});

export function normalizeSettings(input = {}) {
  const result = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (input[key] !== undefined && typeof input[key] === typeof DEFAULTS[key]) result[key] = input[key];
  }
  for (const [key, min, max] of [['concurrency', 1, 8], ['batchSize', 1, 12], ['maxChars', 400, 8000],
    ['temperature', 0, 2], ['timeout', 10000, 300000], ['retries', 0, 4], ['cacheDays', 1, 90], ['fontSize', 10, 32]]) {
    result[key] = Math.min(max, Math.max(min, Number(result[key]) || DEFAULTS[key]));
  }
  result.sites = Array.isArray(input.sites) ? input.sites.filter(x => typeof x === 'string') : [];
  result.excludedSites = Array.isArray(input.excludedSites) ? input.excludedSites.filter(x => typeof x === 'string') : [];
  result.displayMode = result.displayMode === 'translation' ? 'translation' : 'bilingual';
  result.translationStyle = result.translationStyle === 'accent' ? 'accent' : 'natural';
  result.translationIndicator = result.translationIndicator === 'none' ? 'none' : 'line';
  return result;
}

export function resolveEndpoint(baseUrl) {
  const url = new URL(baseUrl.trim());
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含账号、查询参数或片段。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('API 地址需要 HTTPS；本地回环服务可使用 HTTP。');
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/chat/completions')) pathname += '/chat/completions';
  url.pathname = pathname;
  return url.href;
}

export function matchesSite(host, rules) {
  return rules.some(rule => {
    const name = rule.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    return name.startsWith('*.') ? host === name.slice(2) || host.endsWith(name.slice(1)) : host === name;
  });
}
