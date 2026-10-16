import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAudioFile, parseTranscriptionResponse, MAX_AUDIO_SIZE } from '../src/audio.js';

test('audio upload validates nonempty supported media and 20 MiB message budget', () => {
  const file = { name: 'meeting.mp3', size: 2048, type: 'audio/mpeg' };
  assert.equal(validateAudioFile(file), file);
  assert.equal(validateAudioFile({ name: 'recording.webm', size: MAX_AUDIO_SIZE, type: '' }).size, MAX_AUDIO_SIZE);
  assert.throws(() => validateAudioFile({ ...file, size: MAX_AUDIO_SIZE + 1 }), /20 MiB/);
  assert.throws(() => validateAudioFile({ ...file, size: 0 }), /非空/);
  assert.throws(() => validateAudioFile({ name: 'secret.txt', size: 12, type: 'text/plain' }), /音频文件/);
});

test('ASR result must contain timed SRT or VTT and propagates failures', () => {
  const srt = { ok: true, format: 'srt', text: '1\n00:00:01,000 --> 00:00:02,500\nhello\n' };
  assert.equal(parseTranscriptionResponse(srt)[0].end, 2.5);
  assert.equal(parseTranscriptionResponse({ ok: true, format: 'vtt', text: 'WEBVTT\n\n00:01.000 --> 00:02.000\n你好' })[0].text, '你好');
  assert.throws(() => parseTranscriptionResponse({ ok: false, error: 'ASR 地址未配置' }), /ASR 地址未配置/);
  assert.throws(() => parseTranscriptionResponse({ ok: true, text: 'plain untimed text' }), /SRT/);
});
