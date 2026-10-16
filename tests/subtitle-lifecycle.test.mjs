import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachSubtitles, initSubtitles } from '../src/subtitles.js';

test('多视频字幕：复用控制器、时间同步、真实取消信号与移除清理', async () => {
  const dom = new JSDOM('<!doctype html><video id="a"></video><video id="b"></video>', { url: 'https://example.com/video' });
  const names = ['window', 'document', 'location', 'MutationObserver', 'innerWidth', 'innerHeight', 'VTTCue'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location,
    MutationObserver: dom.window.MutationObserver, innerWidth: 1000, innerHeight: 800,
    VTTCue: class { constructor(startTime, endTime, text) { Object.assign(this, { startTime, endTime, text }); } } });
  const videos = [...document.querySelectorAll('video')];
  for (const video of videos) video.addTextTrack = () => ({ cues: [], mode: 'hidden', addCue(cue) { this.cues.push(cue); }, removeCue(cue) { this.cues.splice(this.cues.indexOf(cue), 1); } });
  let a, b, manager;
  try {
    a = attachSubtitles(videos[0], { translateTexts: async texts => texts.map(text => `译:${text}`) });
    assert.equal(attachSubtitles(videos[0]), a);
    a.importText('1\n00:00:00,000 --> 00:00:02,000\nHello world.\n');
    await a.translate(); assert.equal(a.getCues()[0].translated, '译:Hello world.');
    videos[0].currentTime = 1; videos[0].dispatchEvent(new dom.window.Event('timeupdate'));
    assert.equal(document.querySelector('[data-echo-subtitles]').shadowRoot.querySelector('.translation').textContent, '译:Hello world.');
    let aborted = false;
    b = attachSubtitles(videos[1], { translateTexts: (_texts, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }) });
    b.importText('1\n00:00:00,000 --> 00:00:01,000\nStop this translation.\n');
    const pending = b.translate();
    document.querySelectorAll('[data-echo-subtitles]')[1].shadowRoot.querySelector('.stop').click();
    await pending; assert.equal(aborted, true); assert.equal(b.getCues()[0].translated, '');
    manager = initSubtitles(); assert.equal(document.querySelectorAll('[data-echo-subtitles]').length, 2);
    videos[1].remove(); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(document.querySelectorAll('[data-echo-subtitles]').length, 1);
    manager.destroy(); assert.equal(document.querySelectorAll('[data-echo-subtitles]').length, 0);
  } finally {
    manager?.destroy(); a?.destroy(); b?.destroy(); dom.window.close();
    for (const name of names) { if (previous[name] === undefined) delete globalThis[name]; else globalThis[name] = previous[name]; }
  }
});
