(() => {
  if (globalThis.__echoTranslateLoaded) return;
  globalThis.__echoTranslateLoaded = true;
  const state = { settings: null, active: false, generation: 0, records: new Map(), unchanged: new WeakMap(), pending: new Set(), controllers: new Set(), hover: false, queued: new Set() };
  const ignored = 'script,style,noscript,textarea,input,select,option,pre,code,kbd,samp,svg,canvas,math,[contenteditable="true"],[translate="no"],[aria-hidden="true"],[hidden],.notranslate,[data-echo-owned],#echo-translate-root';
  const sourceIgnored = ignored.replace('code,', '');
  const blockTags = 'p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,figcaption,dt,dd,label,button,summary,legend';
  let mutationObserver, intersectionObserver, flushTimer, hoverTimer, lastEditable;
  const host = document.createElement('div'); host.id = 'echo-translate-root'; host.dataset.echoOwned = 'true';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = ':host{all:initial}*{box-sizing:border-box}.ball{position:fixed;right:18px;bottom:26px;background:#126f60;color:white;border:0;border-radius:24px;padding:11px 16px;font:14px system-ui;cursor:pointer;z-index:2147483646;box-shadow:0 3px 20px #0003}.box{position:fixed;right:18px;bottom:78px;width:min(400px,90vw);max-height:60vh;overflow:auto;background:#fff;color:#182f2a;border:1px solid #cbded6;border-radius:12px;padding:16px;z-index:2147483647;font:14px/1.6 system-ui;box-shadow:0 8px 30px #0003;white-space:pre-wrap}.bar{position:fixed;z-index:2147483647;background:#126f60;color:white;border:0;border-radius:8px;padding:7px 12px;cursor:pointer;font:13px system-ui}.close{float:right;background:none;border:0;font:20px system-ui;cursor:pointer;color:#526b63}.result{white-space:pre-wrap}[hidden]{display:none!important}';
  shadow.append(style);
  const ball = document.createElement('button'); ball.className = 'ball'; ball.textContent = '译'; ball.title = 'Echo：翻译 / 恢复网页（Alt+A）';
  const box = document.createElement('section'); box.className = 'box'; box.hidden = true;
  const close = document.createElement('button'); close.className = 'close'; close.textContent = '×'; close.onclick = () => { box.hidden = true; };
  const result = document.createElement('div'); result.className = 'result'; box.append(close, result);
  const liveCaption = document.createElement('div');
  liveCaption.style.cssText = 'position:fixed;bottom:8%;left:10%;width:80%;text-align:center;white-space:pre-wrap;font:22px/1.5 system-ui;color:white;background:#000b;border-radius:8px;padding:8px 14px;pointer-events:none;z-index:2147483647';
  liveCaption.hidden = true; shadow.append(liveCaption);
  const selectionButton = document.createElement('button'); selectionButton.className = 'bar'; selectionButton.textContent = '翻译 / 解释'; selectionButton.hidden = true;
  shadow.append(ball, box, selectionButton); document.documentElement.append(host);
  function show(text) { result.textContent = text; box.hidden = false; }
  async function settings() {
    const response = await chrome.runtime.sendMessage({ type: 'settings' });
    if (!response?.ok) throw new Error(response?.error || '扩展未响应，请刷新网页。');
    state.settings = response.settings; state.hover = state.settings.hoverEnabled;
    ball.hidden = !state.settings.showButton;
    document.documentElement.style.setProperty('--echo-color', state.settings.color);
    document.documentElement.style.setProperty('--echo-size', `${state.settings.fontSize}px`);
    document.documentElement.dataset.echoStyle = state.settings.translationStyle || 'natural';
    document.documentElement.dataset.echoIndicator = state.settings.translationIndicator || 'line';
    return state.settings;
  }
  async function translate(texts, options = {}) {
    const controller = new AbortController(); state.controllers.add(controller);
    const requestId = crypto.randomUUID();
    const abort = () => chrome.runtime.sendMessage({ type: 'cancel', requestId }).catch(() => {});
    controller.signal.addEventListener('abort', abort, { once: true });
    try {
      const response = await chrome.runtime.sendMessage({ type: 'translate', texts, context: document.title, ...options, requestId });
      controller.signal.throwIfAborted();
      if (!response?.ok) throw new Error(response?.error || '翻译失败。');
      return response.translations;
    } finally { state.controllers.delete(controller); }
  }
  function isVisible(element) {
    if (!element?.isConnected || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    if (style.visibility !== 'visible' || style.display === 'none') return false;
    return style.display === 'contents' ? isVisible(element.parentElement) : !!element.getClientRects().length;
  }
  function textContainer(element) {
    for (let current = element; current && current !== document.documentElement; current = current.parentElement) {
      const display = getComputedStyle(current).display;
      if (/^(?:inline-)?(?:flex|grid)$/.test(getComputedStyle(current.parentElement).display)) return current;
      if (current.matches(blockTags) || /^(?:block|flow-root|list-item|table-cell|flex|grid|inline-flex|inline-grid)$/.test(display)) return current;
    }
    return element;
  }
  function isProse(text) {
    if (!/\p{L}/u.test(text)) return false;
    if (/^(?:https?:\/\/|www\.|doi:|mailto:)\S+$/i.test(text)) return false;
    return true;
  }
  function blocks(root = document.body) {
    const found = new Set(); if (!root) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode(node) {
      const parent = node.parentElement;
      return !parent || !node.textContent.trim() || parent.closest(ignored) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    } });
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!isVisible(parent)) continue;
      const block = textContainer(parent);
      if (!state.records.has(block) && !state.pending.has(block) && !block.closest('[data-echo-original]')) found.add(block);
    }
    const leaves = new Set(found);
    for (const element of found) for (let parent = element.parentElement; parent; parent = parent.parentElement) leaves.delete(parent);
    return [...leaves].filter(element => {
      if (element.closest(ignored) || !isVisible(element)) return false;
      const text = sourceText(element);
      return text.length > 1 && isProse(text) && state.unchanged.get(element) !== text;
    });
  }
  function sourceText(block) {
    const parts = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode(node) {
      const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (element.closest(sourceIgnored) || !isVisible(element)) return NodeFilter.FILTER_REJECT;
      return node.nodeType === Node.TEXT_NODE || element.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    } });
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType !== Node.TEXT_NODE) parts.push('\n');
      else parts.push(getComputedStyle(node.parentElement).whiteSpace.startsWith('pre') ? node.textContent : node.textContent.replace(/\s+/g, ' '));
    }
    return parts.join('').replace(/[\t\r ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  }
  function translationLayout(element, text) {
    return element.matches('a,button,label,summary,legend,td,th,li,h2,h3,h4,h5,h6') && text.length <= 90 && !text.includes('\n') ? 'inline' : 'block';
  }
  async function translateBlocks(items, generation) {
    const eligible = items.filter(el => el.isConnected && !state.records.has(el) && !state.pending.has(el));
    if (!eligible.length || generation !== state.generation) return;
    eligible.forEach(el => { state.pending.add(el); el.dataset.echoPending = 'true'; });
    try {
      const texts = eligible.map(sourceText); const translated = await translate(texts);
      if (generation !== state.generation) return;
      eligible.forEach((el, index) => {
        if (!el.isConnected) return;
        if (sourceText(el) !== texts[index]) { state.queued.add(el); flush(); return; }
        if (translated[index].trim() === texts[index].trim()) { state.unchanged.set(el, texts[index]); return; }
        let original = null;
        if (state.settings.displayMode === 'translation') {
          original = document.createElement('span'); original.dataset.echoOriginal = 'true';
          original.append(...el.childNodes); el.append(original);
        }
        const output = document.createElement('echo-translation'); output.dataset.echoTranslation = 'true'; output.dataset.echoOwned = 'true';
        output.style.setProperty('font', 'inherit', 'important');
        output.style.setProperty('color', state.settings.translationStyle === 'accent' ? state.settings.color : 'inherit', 'important');
        if (state.settings.translationStyle === 'accent') output.style.setProperty('font-size', `${state.settings.fontSize}px`, 'important');
        output.textContent = translated[index]; output.lang = state.settings.target;
        output.dataset.echoLayout = translationLayout(el, texts[index]);
        output.style.setProperty('display', output.dataset.echoLayout, 'important');
        el.append(output); el.dataset.echoMode = state.settings.displayMode;
        state.records.set(el, { original, output });
      });
      mutationObserver?.takeRecords();
      ball.textContent = `原文 · ${state.records.size}`;
    } catch (error) { if (generation === state.generation && error.name !== 'AbortError') show(error.message); }
    finally { eligible.forEach(el => { state.pending.delete(el); delete el.dataset.echoPending; }); }
  }
  function flush() {
    clearTimeout(flushTimer); flushTimer = setTimeout(async () => {
      const items = [...state.queued]; state.queued.clear();
      const generation = state.generation;
      for (let i = 0; i < items.length && state.active && generation === state.generation; i += 12) {
        await translateBlocks(items.slice(i, i + 12), generation);
      }
    }, 120);
  }
  function observe(root = document.body) {
    for (const element of blocks(root)) intersectionObserver.observe(element);
  }
  function restore() {
    state.active = false; state.generation++;
    state.controllers.forEach(controller => controller.abort()); state.controllers.clear();
    mutationObserver?.disconnect(); intersectionObserver?.disconnect(); clearTimeout(flushTimer); state.queued.clear();
    for (const [el, record] of state.records) {
      record.output.remove(); if (record.original?.isConnected) record.original.replaceWith(...record.original.childNodes);
      delete el.dataset.echoMode;
    }
    state.records.clear(); state.unchanged = new WeakMap(); state.pending.clear(); ball.textContent = '译';
  }
  async function translatePage() {
    if (state.active) { restore(); return; }
    await settings(); state.active = true; const generation = ++state.generation; ball.textContent = '翻译中…';
    intersectionObserver = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { state.queued.add(entry.target); intersectionObserver.unobserve(entry.target); }
      flush();
    }, { rootMargin: '500px' });
    observe();
    mutationObserver = new MutationObserver(records => {
      if (!state.active || generation !== state.generation) return;
      for (const record of records) {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (target?.closest('[data-echo-owned]')) continue;
        const owner = target?.closest('[data-echo-mode]');
        const rendered = state.records.get(owner);
        if (rendered) {
          rendered.output.remove();
          if (rendered.original?.parentElement === owner) rendered.original.replaceWith(...rendered.original.childNodes);
          state.records.delete(owner); delete owner.dataset.echoMode;
          state.queued.add(owner); flush(); continue;
        }
        if (record.type === 'characterData' && target) observe(target);
        for (const node of record.addedNodes) if (node instanceof Element && !node.closest('[data-echo-owned],[data-echo-original]')) observe(node);
      }
      for (const [element] of state.records) if (!element.isConnected) state.records.delete(element);
      mutationObserver.takeRecords();
    });
    mutationObserver.observe(document.body, { childList: true, characterData: true, subtree: true });
  }
  async function translateSelection(text = getSelection()?.toString(), mode = 'translate') {
    if (!text?.trim()) { show('请先选择要翻译的文字。'); return; }
    selectionButton.hidden = true; show('正在翻译…');
    try { show((await translate([text], { mode }))[0]); } catch (error) { show(error.message); }
  }
  async function translateInput() {
    const input = document.activeElement?.matches('input,textarea,[contenteditable="true"]') ? document.activeElement : lastEditable;
    if (!input || input.matches('input[type="password"],input[type="email"],input[type="number"]')) { show('请将光标放在普通文本输入框。'); return; }
    const editable = input.isContentEditable; const start = input.selectionStart, end = input.selectionEnd;
    const text = editable ? input.innerText : (start !== end ? input.value.slice(start, end) : input.value);
    if (!text?.trim()) return;
    show('正在翻译输入框内容…');
    try {
      const value = (await translate([text]))[0];
      if (editable) { show(value + '\n\n富文本输入框：请确认后自行复制替换，以保留编辑器格式。'); return; }
      const next = start !== end ? input.value.slice(0, start) + value + input.value.slice(end) : value;
      const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, next);
      input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
      box.hidden = true;
    } catch (error) { show(error.message); }
  }
  async function subtitles() {
    const module = await import(chrome.runtime.getURL('src/subtitles.js'));
    if (module.initSubtitles) {
      state.subtitleController ??= module.initSubtitles({ source: state.settings?.source, target: state.settings?.target });
      state.subtitleController.refresh();
    }
    else { const video = document.querySelector('video'); if (!video) throw new Error('当前页面没有视频。'); await module.attachSubtitles(video, {}); }
  }
  ball.onclick = () => translatePage().catch(error => show(error.message));
  selectionButton.onclick = () => translateSelection(undefined, 'explain');
  document.addEventListener('focusin', event => { if (event.target.matches?.('input,textarea,[contenteditable="true"]')) lastEditable = event.target; });
  document.addEventListener('mouseup', event => {
    if (event.composedPath().includes(host) || !state.settings?.selectionPopup) return;
    setTimeout(() => {
      const selected = getSelection(); if (!selected?.toString().trim() || !selected.rangeCount) { selectionButton.hidden = true; return; }
      const rect = selected.getRangeAt(0).getBoundingClientRect(); selectionButton.hidden = false;
      selectionButton.style.left = `${Math.min(innerWidth - 130, Math.max(5, rect.left))}px`;
      selectionButton.style.top = `${Math.min(innerHeight - 40, Math.max(5, rect.bottom + 5))}px`;
    }, 20);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { box.hidden = true; selectionButton.hidden = true; }
  });
  document.addEventListener('mousemove', event => {
    clearTimeout(hoverTimer);
    if (!state.hover || !event.altKey || event.target.closest?.(ignored)) return;
    const element = event.target.closest(blockTags) || event.target;
    hoverTimer = setTimeout(() => translateSelection(sourceText(element)), 650);
  }, { passive: true });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    const actions = { 'translate-page': translatePage, 'restore-page': restore, 'translate-selection': () => translateSelection(message.text),
      'explain-selection': () => translateSelection(message.text, 'explain'), 'translate-input': translateInput,
      'toggle-hover': () => { state.hover = !state.hover; show(state.hover ? '已启用：按住 Alt 悬停文字即可翻译。' : '已关闭悬停翻译。'); },
      'translate-subtitles': subtitles, 'live-caption': () => { liveCaption.textContent = String(message.text || '').slice(0, 12000); liveCaption.hidden = !message.text; },
      'page-status': () => ({ active: state.active, count: state.records.size }) };
    if (!actions[message.type]) return;
    Promise.resolve().then(actions[message.type]).then(value => respond({ ok: true, ...value }), error => { show(error.message); respond({ ok: false, error: error.message }); });
    return true;
  });
  settings().then(config => {
    const match = rule => location.hostname === rule || rule.startsWith('*.') && (location.hostname === rule.slice(2) || location.hostname.endsWith(rule.slice(1)));
    if (!config.excludedSites.some(match) && (config.autoTranslate || config.sites.some(match))) translatePage().catch(error => show(error.message));
  }).catch(error => show(error.message));
})();
