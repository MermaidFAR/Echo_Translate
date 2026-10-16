import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtension } from '../tools/browser-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('论文网页自然显示：整行作者、继承字体、行内标签、隐藏描述及原 DOM 保留', { timeout: 60000 }, async () => {
  const fixture = await readFile(path.join(root, 'tests/fixtures/arxiv-reading.html'));
  const themes = {
    news: { font: 'Georgia, serif', size: '20px', height: '34px', color: '#302c29', background: '#faf6ed', direction: 'ltr' },
    docs: { font: 'Arial, sans-serif', size: '15px', height: '25px', color: '#d5dfed', background: '#17212e', direction: 'ltr' },
    cards: { font: 'Verdana, sans-serif', size: '13px', height: '20px', color: '#373755', background: '#f5f3fb', direction: 'ltr' },
    rtl: { font: 'Tahoma, sans-serif', size: '18px', height: '30px', color: '#302b36', background: '#fff', direction: 'rtl' },
  };
  const themePage = theme => `<!doctype html><html dir="${theme.direction}"><head><style>
    body{font-family:${theme.font};font-size:${theme.size};line-height:${theme.height};color:${theme.color};background:${theme.background};margin:24px}
    main{max-width:960px;margin:auto}h1{font-size:1.6em;line-height:1.25}.copy{font-weight:500;letter-spacing:.2px}
    .copy>a{color:#ab54b3;font-size:.9em}.copy>span{font:9px monospace!important;color:magenta!important}
    nav{display:flex;gap:18px;font-size:13px;flex-wrap:wrap}nav>a{color:inherit}.cards{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{padding:12px;border:1px solid #8895a8;border-radius:8px}.card h2{font-size:1.1em}
    </style></head><body><main><nav><a id="nav-one" href="#home">Home</a><a href="#help">Documentation</a></nav><h1>A page with its own typography</h1>
    <p id="copy" class="copy">Read <a id="theme-link" href="#manual">the manual</a> before running the example. This paragraph should retain the page's original typography.</p>
    <div class="cards"><article class="card"><h2>First card</h2><p>A short description with its original grid layout.</p></article><article class="card"><h2>Second card</h2><p>A second description with the same page styling.</p></article></div>
    <pre translate="no">const untouched = true;</pre></main></body></html>`;
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/paper') { response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); response.end(fixture); return; }
    if (request.url.startsWith('/theme/')) {
      const theme = themes[request.url.slice('/theme/'.length)];
      if (theme) { response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); response.end(themePage(theme)); return; }
    }
    if (request.url !== '/chat/completions') { response.writeHead(404); response.end(); return; }
    let bytes = ''; for await (const part of request) bytes += part;
    const body = JSON.parse(bytes); const { items } = JSON.parse(body.messages[1].content); requests.push(body);
    const labels = {
      'Current browse context:': '当前浏览上下文：', '< prev | next >': '< 上一页 | 下一页 >',
      'References & Citations': '参考文献与引用', 'Google Scholar': '谷歌学术', 'View PDF': '查看 PDF',
      'TeX Source': 'TeX 源文件', 'Comments:': '备注：', 'Website: this https URL': '网站：此 HTTPS 链接',
      'Subjects:': '学科：', 'Artificial Intelligence (cs.AI); Machine Learning (cs.LG)': '人工智能（cs.AI）；机器学习（cs.LG）',
      'Cite as:': '引用格式：', 'arXiv:2301.04104 [cs.AI]': 'arXiv:2301.04104 [cs.AI]',
      'Submission history': '提交历史记录', 'From: Danijar Hafner': '作者：Danijar Hafner',
      'The implementation calls train_step() after each batch.': '实现会在每个批次之后调用 train_step()。',
    };
    const translate = text => labels[text] ?? (text === 'DreamerV3' ? text : text.includes('Developing a general algorithm')
      ? '开发一种能够在广泛应用领域中学习并完成任务的通用算法，一直是人工智能领域的基本挑战。我们提出 DreamerV3：仅需一套配置，就能在超过 150 项不同任务中超越专用方法。'
      : text.startsWith('Danijar Hafner,') ? '达尼雅尔·哈夫纳、尤尔吉斯·帕苏科尼斯、吉米·巴、蒂莫西·利利克拉普'
      : text.startsWith('Mastering Diverse') ? '通过世界模型掌握多元领域' : `译：${text}`);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: items.map(item => ({ id: item.id, text: translate(item.text) })) }) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let app;
  try {
    app = await launchExtension(path.join(root, 'dist/Echo_Translate'));
    const { context, worker, id } = app; context.setDefaultTimeout(10000);
    await worker.evaluate(async baseUrl => {
      await chrome.storage.local.set({ settings: { baseUrl, model: 'display-fixture', retries: 0, fontSize: 16, color: '#147d68' }, apiKey: 'local-fixture-placeholder' });
    }, origin);
    const page = await context.newPage(); await page.goto(`${origin}/paper`);
    await page.waitForSelector('#echo-translate-root', { state: 'attached' });
    const before = await page.evaluate(() => {
      globalThis.originalAuthor = document.querySelector('#author-one');
      globalThis.authorClicks = 0; originalAuthor.onclick = event => { event.preventDefault(); authorClicks++; };
      return { authors: document.querySelector('#authors').innerHTML, body: document.body.style.cssText };
    });
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, `${origin}/paper`);
    const send = type => worker.evaluate(({ tabId, type }) => chrome.tabs.sendMessage(tabId, { type }), { tabId, type });
    await send('translate-page'); await page.waitForSelector('#abstract > [data-echo-translation]');
    await page.waitForSelector('#authors > [data-echo-translation]');
    assert.equal(await page.locator('#authors [data-echo-translation]').count(), 1);
    assert.equal(await page.locator('#authors > a').count(), 4);
    assert.equal(await page.locator('#authors a [data-echo-translation]').count(), 0);
    assert.equal(await page.locator('#abstract [data-echo-original]').count(), 0);
    assert.equal(await page.locator('#comments-label > [data-echo-translation]').getAttribute('data-echo-layout'), 'inline');
    assert.equal(await page.locator('#submission > [data-echo-translation]').getAttribute('data-echo-layout'), 'inline');
    assert.equal(await page.locator('#toolbar > a').count(), 2);
    assert.equal(await page.locator('#view-pdf > [data-echo-translation]').getAttribute('data-echo-layout'), 'inline');
    const styles = await page.locator('#abstract').evaluate(element => {
      const source = getComputedStyle(element), translated = getComputedStyle(element.querySelector('[data-echo-translation]'));
      return { sourceColor: source.color, color: translated.color, sourceSize: source.fontSize, size: translated.fontSize,
        sourceFont: source.fontFamily, font: translated.fontFamily, sourceHeight: source.lineHeight, height: translated.lineHeight,
        border: translated.borderInlineStartWidth, padding: translated.paddingInlineStart };
    });
    assert.equal(styles.color, styles.sourceColor); assert.equal(styles.size, styles.sourceSize);
    assert.equal(styles.font, styles.sourceFont); assert.equal(styles.height, styles.sourceHeight);
    assert.equal(styles.border, '2px'); assert.ok(parseFloat(styles.padding) > 0);
    await page.evaluate(() => { document.documentElement.dataset.echoIndicator = 'none'; });
    assert.equal(await page.locator('#abstract > [data-echo-translation]').evaluate(element => getComputedStyle(element).borderInlineStartWidth), '0px');
    await page.evaluate(() => { document.documentElement.dataset.echoIndicator = 'line'; });
    const sent = requests.flatMap(body => JSON.parse(body.messages[1].content).items.map(item => item.text));
    assert.ok(sent.some(text => text === 'Danijar Hafner, Jurgis Pasukonis, Jimmy Ba, Timothy Lillicrap'));
    assert.ok(sent.some(text => text === 'The implementation calls train_step() after each batch.'));
    assert.equal(sent.some(text => /^(Title:|Abstract:)/.test(text)), false);
    assert.equal(sent.includes('2023-01'), false);
    assert.equal(await page.locator('#same [data-echo-translation]').count(), 0);
    await page.locator('#author-one').click(); assert.equal(await page.evaluate(() => authorClicks), 1);
    await mkdir(path.join(root, 'evidence/screenshots'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'evidence/screenshots/reading-natural.png'), fullPage: true });
    await page.evaluate(() => { document.querySelector('#author-one').firstChild.textContent = 'Danijar H.'; });
    await page.waitForFunction(() => document.querySelector('#authors > [data-echo-translation]')?.textContent.includes('Danijar H.'));
    before.authors = before.authors.replace('Danijar Hafner', 'Danijar H.');
    await page.evaluate(() => { document.body.style.color = '#dddddd'; document.body.style.backgroundColor = '#111111'; });
    assert.equal(await page.locator('#abstract > [data-echo-translation]').evaluate(element => getComputedStyle(element).color), 'rgb(221, 221, 221)');
    await send('restore-page');
    assert.equal(await page.locator('#authors').innerHTML(), before.authors);
    assert.equal(await page.evaluate(() => originalAuthor === document.querySelector('#author-one')), true);
    await page.locator('#author-one').click(); assert.equal(await page.evaluate(() => authorClicks), 2);
    await worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, translationStyle: 'accent', color: '#147d68', fontSize: 20 } });
    });
    await send('translate-page'); await page.waitForSelector('#abstract > [data-echo-translation]');
    assert.equal(await page.locator('#abstract > [data-echo-translation]').evaluate(element => getComputedStyle(element).color), 'rgb(20, 125, 104)');
    assert.equal(await page.locator('#abstract > [data-echo-translation]').evaluate(element => getComputedStyle(element).fontSize), '20px');
    const options = await context.newPage(); await options.goto(`chrome-extension://${id}/pages/options.html`);
    await options.waitForFunction(() => document.querySelector('#translationStyle')?.value === 'accent');
    await options.locator('#translationStyle').selectOption('natural');
    assert.equal(await options.locator('#fontSize').isDisabled(), true);
    await worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, translationStyle: 'natural', translationIndicator: 'line' } });
    });
    for (const [name, theme] of Object.entries(themes)) {
      const themed = await context.newPage(); await themed.goto(`${origin}/theme/${name}`);
      await themed.waitForSelector('#echo-translate-root', { state: 'attached' });
      const original = await themed.locator('#theme-link').evaluate(element => {
        const style = getComputedStyle(element); return { color: style.color, size: style.fontSize, parentTag: element.parentElement.tagName };
      });
      const themedId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, `${origin}/theme/${name}`);
      await worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: 'translate-page' }), themedId);
      await themed.waitForSelector('#copy > [data-echo-translation]');
      const inherited = await themed.locator('#copy').evaluate(element => {
        const parent = getComputedStyle(element), output = getComputedStyle(element.querySelector('[data-echo-translation]'));
        const props = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'color', 'letterSpacing', 'direction'];
        return { source: Object.fromEntries(props.map(key => [key, parent[key]])), translation: Object.fromEntries(props.map(key => [key, output[key]])),
          lineStart: output.borderInlineStartWidth, right: output.borderRightWidth };
      });
      assert.deepEqual(inherited.translation, inherited.source, `${name}: 译文应继承实际网页样式`);
      assert.equal(inherited.lineStart, '2px');
      if (theme.direction === 'rtl') assert.equal(inherited.right, '2px');
      assert.deepEqual(await themed.locator('#theme-link').evaluate(element => {
        const style = getComputedStyle(element); return { color: style.color, size: style.fontSize, parentTag: element.parentElement.tagName };
      }), original, `${name}: 不得改变原链接的直接子元素样式`);
      assert.equal(await themed.locator('.cards > .card').count(), 2);
      assert.equal(await themed.locator('nav > a').count(), 2);
      assert.equal(await themed.locator('#nav-one > [data-echo-translation]').getAttribute('data-echo-layout'), 'inline');
      await themed.screenshot({ path: path.join(root, `evidence/screenshots/reading-${name}.png`), fullPage: true });
      await themed.close();
    }
    await writeFile(path.join(root, 'evidence/reading-layout-validation.json'), JSON.stringify({
      testedAt: new Date().toISOString(), status: 'pass', browser: context.browser().version(),
      scope: '仅显示排版；模型、提示词、缓存协议沿用上一版。译文为固定模拟文本，不评价翻译质量。',
      authorsGrouped: true, originalNodesAndDirectChildSelectorsPreserved: true, hiddenLabelsExcluded: true,
      inheritsFontColorSizeLineHeight: true, darkThemeInheritance: true, compactInlineLabels: true,
      identicalTranslationsSuppressed: true, accentStyleOptional: true, paragraphIndicatorRetained: true, indicatorOptional: true,
      adaptiveThemes: Object.keys(themes), rightToLeftIndicator: true, originalDirectChildStylesUnchanged: true,
      screenshot: 'evidence/screenshots/reading-natural.png',
    }, null, 2));
  } finally { await app?.close(); await new Promise(resolve => server.close(resolve)); }
});
