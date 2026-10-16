import test from 'node:test';
import assert from 'node:assert/strict';
import { offsetCues } from '../src/live-audio.js';
test('实时音频字幕按录制时间偏移，保留原文和译文', () => {
  const original = [{ start: 0.5, end: 2, text: 'hello', translated: '你好' }];
  assert.deepEqual(offsetCues(original, 15), [{ start: 15.5, end: 17, text: 'hello', translated: '你好' }]);
  assert.equal(original[0].start, 0.5);
});
