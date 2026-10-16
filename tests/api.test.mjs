import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekClient, parseTranslations, splitText } from '../src/api.js';
import { normalizeSettings, resolveEndpoint, matchesSite } from '../src/settings.js';
import { TranslationCache } from '../src/cache.js';

function response(items) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
    content: JSON.stringify({ translations: items.map(x => ({ id: x.id, text: `译文:${x.text}` })) }),
  } }] }), { status: 200 });
}

test('官方、v1 和完整地址正确规范化；拒绝泄露式和非 HTTPS 地址', () => {
  assert.equal(resolveEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
  assert.equal(resolveEndpoint('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(resolveEndpoint('http://127.0.0.1:8000/chat/completions'), 'http://127.0.0.1:8000/chat/completions');
  for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com?key=secret', 'file:///tmp/api']) {
    assert.throws(() => resolveEndpoint(url));
  }
});

test('按编号恢复模型返回顺序；拒绝漏项、重复和无效编号', () => {
  assert.deepEqual(parseTranslations('{"translations":[{"id":1,"text":"二"},{"id":0,"text":"一"}]}', 2), ['一', '二']);
  assert.deepEqual(parseTranslations('```json\n{"translations":["一"]}\n```', 1), ['一']);
  assert.throws(() => parseTranslations('{"translations":[""]}', 1));
  assert.throws(() => parseTranslations('{"translations":[{"id":0,"text":"  "}]}', 1));
  for (const value of ['{}', '{"translations":[]}', '{"translations":[{"id":0,"text":"a"},{"id":0,"text":"b"}]}']) {
    assert.throws(() => parseTranslations(value, 2));
  }
});

test('文本分段往返保持换行与 Unicode，不切断代理对', () => {
  const text = 'a'.repeat(399) + '😀中文\n' + 'b'.repeat(450);
  const parts = splitText(text, 400); assert.equal(parts.join(''), text);
  assert.ok(parts.every(part => part.length <= 400));
  assert.ok(parts.every(part => !/[\uD800-\uDBFF]$/.test(part)));
});

test('请求使用用户接口、术语和官方协议；缓存避免相同请求', async () => {
  let calls = 0;
  const cache = new TranslationCache();
  const client = new DeepSeekClient({ baseUrl: 'http://localhost:8000', glossary: 'world model = 世界模型' }, 'placeholder', {
    cache, fetchImpl: async (url, options) => {
      calls++; assert.equal(url, 'http://localhost:8000/chat/completions');
      assert.equal(options.credentials, 'omit'); assert.equal(options.headers.Authorization, 'Bearer placeholder');
      const body = JSON.parse(options.body); assert.equal(body.thinking.type, 'disabled');
      assert.match(body.messages[0].content, /world model = 世界模型/);
      return response(JSON.parse(body.messages[1].content).items);
    },
  });
  const result = await client.translate(['Hello', 'World']); assert.deepEqual(result, ['译文:Hello', '译文:World']);
  assert.deepEqual(await client.translate(['Hello', 'World']), result); assert.equal(calls, 1);
  await client.translate(['Hello'], { target: 'ja' }); assert.equal(calls, 2);
});

test('跨调用并发上限生效，结果保序', async () => {
  let active = 0, peak = 0;
  const client = new DeepSeekClient({ concurrency: 2, batchSize: 1, cacheEnabled: false }, 'placeholder', {
    fetchImpl: async (_url, options) => {
      active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 8)); active--;
      return response(JSON.parse(JSON.parse(options.body).messages[1].content).items);
    },
  });
  const [a, b] = await Promise.all([client.translate(['a', 'b', 'c']), client.translate(['d', 'e'])]);
  assert.deepEqual(a, ['译文:a', '译文:b', '译文:c']); assert.deepEqual(b, ['译文:d', '译文:e']); assert.equal(peak, 2);
});

test('401不重试、不转发服务端可能包含密钥的错误正文', async () => {
  let calls = 0;
  const client = new DeepSeekClient({}, 'placeholder', { fetchImpl: async () => {
    calls++; return new Response('secret echo: placeholder', { status: 401 });
  } });
  await assert.rejects(client.translate(['Hello']), error => error.status === 401 && !error.message.includes('placeholder'));
  assert.equal(calls, 1);
});

test('取消能中断正在执行与排队的请求', async () => {
  const controller = new AbortController(); let calls = 0;
  const client = new DeepSeekClient({ concurrency: 1, batchSize: 1 }, 'placeholder', {
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      calls++; options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }),
  });
  const pending = client.translate(['a', 'b', 'c'], { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 30)); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(calls, 1);
});

test('批量协议不匹配时回退逐条，避免错配译文', async () => {
  let calls = 0;
  const client = new DeepSeekClient({ cacheEnabled: false }, 'placeholder', { fetchImpl: async (_url, options) => {
    calls++; const items = JSON.parse(JSON.parse(options.body).messages[1].content).items;
    if (items.length > 1) return response([]); return response(items);
  } });
  assert.deepEqual(await client.translate(['a', 'b']), ['译文:a', '译文:b']); assert.equal(calls, 3);
});

test('设置仅保留已知字段；域名规则有明确边界', () => {
  const value = normalizeSettings({ apiKey: 'not-exported', concurrency: 100, target: 'ja' });
  assert.equal(value.apiKey, undefined); assert.equal(value.concurrency, 8); assert.equal(value.target, 'ja');
  assert.equal(matchesSite('sub.example.com', ['*.example.com']), true);
  assert.equal(matchesSite('badexample.com', ['*.example.com']), false);
});
