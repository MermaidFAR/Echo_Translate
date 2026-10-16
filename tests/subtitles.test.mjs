import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtitles, serializeSubtitles, parseSubtitleTimestamp, formatSubtitleTimestamp, getActiveSubtitleCues, parseYoutubeCaptionResponse } from '../src/subtitles.js';

test('SRT preserves multiline cues, UTF-8 and millisecond precision', () => {
  const cues = parseSubtitles('\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\nHello &amp; world\r\n第二行\r\n\r\n2\r\n00:01:01,000 --> 00:01:02,000\r\nNext\r\n');
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1.25, end: 3.5, text: 'Hello & world\n第二行', translated: '' });
  assert.deepEqual(parseSubtitles(serializeSubtitles(cues)), cues);
});

test('WebVTT supports cue IDs, settings, annotations and comments', () => {
  const cues = parseSubtitles('WEBVTT\n\nNOTE a comment\nignore\n\nSTYLE\n::cue {color:white}\n\ncaption-a\n01:02.050 --> 01:05.200 align:start position:0%\n<v Speaker><c.yellow>Hello</c></v> &#x1F600;\n');
  assert.equal(cues[0].start, 62.05);
  assert.equal(cues[0].text, 'Hello 😀');
  const output = serializeSubtitles([{ ...cues[0], translated: '你好 😀' }], 'vtt');
  assert.match(output, /^WEBVTT\n\n00:01:02\.050 --> 00:01:05\.200\nHello 😀\n你好 😀\n$/);
});

test('timestamp rounding carries into next second and handles long videos', () => {
  assert.equal(formatSubtitleTimestamp(59.9996), '00:01:00,000');
  assert.equal(formatSubtitleTimestamp(366100.005, 'vtt'), '101:41:40.005');
  assert.equal(parseSubtitleTimestamp('01:02:03,04'), 3723.04);
  assert.throws(() => parseSubtitleTimestamp('00:99:00.000'));
  assert.throws(() => parseSubtitles('1\n00:00:04,000 --> 00:00:02,000\nno'));
  assert.throws(() => parseSubtitles('plain text'));
  assert.throws(() => formatSubtitleTimestamp(Infinity));
});

test('bilingual and translation exports retain timing', () => {
  const cues = [{ start: 0, end: 1.2, text: 'Original', translated: '译文' }];
  assert.equal(parseSubtitles(serializeSubtitles(cues, 'srt', 'bilingual'))[0].text, 'Original\n译文');
  assert.equal(parseSubtitles(serializeSubtitles(cues, 'srt', 'translation'))[0].text, '译文');
  assert.equal(parseSubtitles(serializeSubtitles(cues, 'vtt', 'source'))[0].text, 'Original');
  assert.deepEqual(getActiveSubtitleCues(cues, 1.2), []);
  assert.equal(getActiveSubtitleCues(cues, 1.5, -0.5).length, 1);
});

test('YouTube JSON3 and XML transcripts are parsed without executing markup', () => {
  const json = JSON.stringify({ events: [{ tStartMs: 100, dDurationMs: 900, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] }, { tStartMs: 1 }] });
  assert.deepEqual(parseYoutubeCaptionResponse(json), [{ start: 0.1, end: 1, text: 'Hello world', translated: '' }]);
  const xml = '<transcript><text start="1.5" dur="2">A &amp; B<br/>C</text></transcript>';
  assert.equal(parseYoutubeCaptionResponse(xml)[0].text, 'A & B\nC');
  const xml3 = '<timedtext><body><p t="1500" d="2500"><s>One</s><s> two</s></p></body></timedtext>';
  assert.deepEqual(parseYoutubeCaptionResponse(xml3), [{ start: 1.5, end: 4, text: 'One two', translated: '' }]);
});
