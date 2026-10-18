import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, linkify, sharePage } from '../lib/share-page.js';

const share = (over = {}) => ({
  id: 'Ab3xK9QpZz', createdAt: '2026-10-18T06:00:00Z', expiresAt: '2026-10-25T06:00:00Z',
  text: 'hi', files: [], ...over,
});

test('user text can never become markup', () => {
  const { html } = sharePage(share({ text: '<img src=x onerror=alert(1)> "quoted" & \'single\'' }));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot; &amp; &#39;single&#39;'));
});

test('file names are escaped too', () => {
  const { html } = sharePage(share({ text: '', files: [{ name: '"><script>x</script>.pdf', size: 10 }] }));
  assert.ok(!html.includes('<script>x'));
});

test('only http(s) links become clickable, without breaking out of the attribute', () => {
  assert.equal(linkify('see https://a.example/x?y=1&z=2.'), 'see <a href="https://a.example/x?y=1&amp;z=2" rel="noopener noreferrer nofollow" target="_blank">https://a.example/x?y=1&amp;z=2</a>.');
  assert.equal(linkify('javascript:alert(1)'), 'javascript:alert(1)');
  assert.ok(!linkify('https://a.example/"onmouseover="x').includes('"onmouseover'));
});

test('missing and expired shares get their own pages', () => {
  assert.equal(sharePage(null).status, 404);
  assert.equal(sharePage(share(), { now: new Date('2026-10-26T00:00:00Z') }).status, 410);
  assert.equal(sharePage(share(), { now: new Date('2026-10-19T00:00:00Z') }).status, 200);
});

test('escapeHtml', () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});
