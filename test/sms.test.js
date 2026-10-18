import test from 'node:test';
import assert from 'node:assert/strict';
import { composeSms, normalizePhone, segments, formatBytes } from '../public/js/sms.js';

test('Indian numbers are accepted in every common way of typing them', () => {
  for (const raw of ['9876543210', '98765 43210', '098765-43210', '+91 98765 43210', '919876543210', '(+91) 98765-43210']) {
    assert.deepEqual(normalizePhone(raw), { ok: true, e164: '+919876543210' }, raw);
  }
});

test('international numbers need a leading +', () => {
  assert.deepEqual(normalizePhone('+44 7700 900123'), { ok: true, e164: '+447700900123' });
  assert.equal(normalizePhone('447700900123').ok, false);
});

test('non-numbers and landline-looking numbers are refused with a reason', () => {
  for (const raw of ['', '   ', 'call me', '12345', '5876543210', '+0123456789']) {
    const r = normalizePhone(raw);
    assert.equal(r.ok, false, raw);
    assert.ok(r.error.length > 10, raw);
  }
});

test('GSM-7 text: 160 characters fit one SMS, longer ones use 153 per part', () => {
  assert.deepEqual(segments(''), { encoding: 'gsm7', length: 0, parts: 0, perPart: 160 });
  assert.equal(segments('a'.repeat(160)).parts, 1);
  assert.equal(segments('a'.repeat(161)).parts, 2);
  assert.equal(segments('a'.repeat(306)).parts, 2);
  assert.equal(segments('a'.repeat(307)).parts, 3);
});

test('extension characters like { } [ ] € count twice', () => {
  const s = segments('{}');
  assert.equal(s.encoding, 'gsm7');
  assert.equal(s.length, 4);
  assert.equal(segments('€'.repeat(80)).parts, 1);
  assert.equal(segments('€'.repeat(81)).parts, 2);
});

test('emoji, Hindi or curly quotes switch the SMS to Unicode: 70 per SMS, 67 per part', () => {
  assert.equal(segments('“quoted”').encoding, 'ucs2');
  assert.equal(segments('नमस्ते').encoding, 'ucs2');
  assert.equal(segments('x'.repeat(70) .replace(/x$/, '😀')).parts, 2); // the emoji is two UTF-16 units → 71
  assert.equal(segments('क'.repeat(70)).parts, 1);
  assert.equal(segments('क'.repeat(71)).parts, 2);
  assert.equal(segments('क'.repeat(134)).parts, 2);
  assert.equal(segments('क'.repeat(135)).parts, 3);
});

const LINK = 'https://mmbasap.example/s/Ab3xK9QpZz';

test('short text with no files is sent as-is so it can be copied from the SMS', () => {
  assert.deepEqual(composeSms({ text: '  hello\r\nthere  ', files: [], link: LINK }), { mode: 'inline', body: 'hello\nthere' });
  const three = 'a'.repeat(459); // exactly 3 GSM-7 parts
  assert.equal(composeSms({ text: three, link: LINK }).mode, 'inline');
});

test('text longer than three SMS goes as a preview plus the link', () => {
  const sms = composeSms({ text: 'word '.repeat(200), link: LINK });
  assert.equal(sms.mode, 'link');
  const lines = sms.body.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].endsWith('...'));
  assert.ok(lines[0].length <= 120);
  assert.equal(lines[1], `Read all: ${LINK}`);
});

test('any file makes it a link message, naming the file or counting them', () => {
  const one = composeSms({ text: 'see this', files: [{ name: 'Q3 report.pdf' }], link: LINK });
  assert.deepEqual(one, { mode: 'link', body: `see this\nFile: Q3 report.pdf\nOpen: ${LINK}` });
  const many = composeSms({ text: '', files: [{ name: 'a' }, { name: 'b' }], link: LINK });
  assert.equal(many.body, `2 files\nOpen: ${LINK}`);
});

test('a link message stays within two SMS even with the longest preview and file name', () => {
  const body = composeSms({ text: 'x'.repeat(5000), files: [{ name: 'n'.repeat(300) }], link: LINK }).body;
  assert.ok(segments(body).parts <= 2, body);
});

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(300000), '293 KB');
  assert.equal(formatBytes(25 * 1024 * 1024), '25 MB');
});
