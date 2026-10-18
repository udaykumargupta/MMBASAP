// End-to-end API tests: the real handler on a real HTTP port, with file
// storage in a temp folder, local files and the dry-run SMS channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHandler, startOfDayIST } from '../lib/app.js';
import { createSessions, createLoginLimiter } from '../lib/auth.js';
import { createChannels } from '../lib/channels/index.js';
import { consoleSms } from '../lib/channels/console.js';
import { ChannelError } from '../lib/channels/sms-gate.js';
import { fileShares } from '../lib/shares.js';
import { localFiles } from '../lib/files.js';

const quiet = { log() {}, warn() {}, error() {} };
const PASSCODE = 'open-sesame';

async function start({ passcode = PASSCODE, sms, dailyLimit = 50, cronSecret = '', requireAuth = false, setupMissing = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmbasap-test-'));
  const clock = { t: Date.parse('2026-10-18T06:00:00Z') };
  const now = () => new Date(clock.t);
  const channel = sms || consoleSms({ log: quiet });
  const auth = passcode ? { passcode, sessions: createSessions({ secret: 's'.repeat(40), now: () => clock.t }) } : {};
  const shares = fileShares(dir);
  const files = localFiles({ dir: path.join(dir, 'files'), secret: 'k'.repeat(32), now: () => clock.t });
  const handle = createHandler({
    publicDir: null, auth, shares, files, channels: createChannels({ sms: channel }), dailyLimit, cronSecret,
    requireAuth, setupMissing, log: quiet, now, limiter: createLoginLimiter({ max: 3, now: () => clock.t }),
  });
  const server = http.createServer(handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, url, { token, body, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base + url, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html or text */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  const login = async () => (await call('POST', '/api/login', { body: { passcode: PASSCODE } })).json.token;
  /** Upload through the API like the browser does. */
  async function uploadFile(token, name, content, type = 'application/pdf') {
    const r = await call('POST', '/api/upload-url', { token, body: { name, type, size: Buffer.byteLength(content) } });
    assert.equal(r.status, 200, r.text);
    const put = await fetch(base + r.json.upload.url, { method: 'PUT', body: content, headers: r.json.upload.headers });
    assert.equal(put.status, 200);
    return { id: r.json.fileId, name, type, size: Buffer.byteLength(content) };
  }
  test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { call, login, uploadFile, clock, channel, shares, base };
}

test('config is public and lists SMS as the only working channel', async () => {
  const { call } = await start();
  const r = await call('GET', '/api/public/config');
  assert.equal(r.status, 200);
  assert.equal(r.json.authRequired, true);
  assert.deepEqual(r.json.channels.map((c) => [c.id, c.enabled]), [['sms', true], ['whatsapp', false], ['email', false]]);
  assert.equal(r.json.limits.maxFiles, 5);
});

test('everything else needs the passcode session', async () => {
  const { call } = await start();
  for (const [m, u] of [['GET', '/api/me'], ['GET', '/api/history'], ['POST', '/api/send'], ['POST', '/api/upload-url'], ['GET', '/api/shares/AAAAAAAAAA/status']]) {
    assert.equal((await call(m, u, { body: m === 'POST' ? {} : undefined })).status, 401, `${m} ${u}`);
  }
  assert.equal((await call('GET', '/api/me', { token: 'forged.token.here' })).status, 401);
});

test('wrong passcodes are refused, and repeated guesses get locked out', async () => {
  const { call, clock } = await start();
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/login', { body: { passcode: 'nope' } })).status, 401);
  const locked = await call('POST', '/api/login', { body: { passcode: PASSCODE } });
  assert.equal(locked.status, 429);
  clock.t += 16 * 60 * 1000;
  const ok = await call('POST', '/api/login', { body: { passcode: PASSCODE } });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/me', { token: ok.json.token })).status, 200);
});

test('sessions expire', async () => {
  const { call, login, clock } = await start();
  const token = await login();
  clock.t += 31 * 24 * 60 * 60 * 1000;
  assert.equal((await call('GET', '/api/me', { token })).status, 401);
});

test('short text goes out inline to the normalised number', async () => {
  const { call, login, channel } = await start();
  const token = await login();
  const r = await call('POST', '/api/send', { token, body: { to: '98765 43210', text: '  link: https://example.com/x  ' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.share.to, '+919876543210');
  assert.equal(r.json.share.mode, 'inline');
  assert.equal(r.json.share.status, 'sent');
  assert.deepEqual(channel.sent, [{ to: '+919876543210', text: 'link: https://example.com/x', idempotencyKey: r.json.share.id }]);
  assert.match(r.json.share.id, /^[A-Za-z0-9]{10}$/);
});

test('bad input is explained, not sent', async () => {
  const { call, login, channel } = await start();
  const token = await login();
  const cases = [
    [{ to: '12345', text: 'hi' }, 'bad_number'],
    [{ to: '9876543210', text: '   ' }, 'empty'],
    [{ to: '9876543210', text: 'x'.repeat(10_001) }, 'too_long'],
    [{ to: '9876543210', text: 'hi', channel: 'whatsapp' }, 'channel_unavailable'],
    [{ to: '9876543210', files: [{ id: '../../etc/passwd', name: 'x' }] }, 'bad_request'],
    [{ to: '9876543210', files: [{ id: 'mmbasap/AAAAAAAAAAAAAAAA/never-uploaded.pdf', name: 'never-uploaded.pdf' }] }, 'upload_missing'],
    [{ to: '9876543210', files: Array.from({ length: 6 }, () => ({ id: 'mmbasap/AAAAAAAAAAAAAAAA/a.pdf' })) }, 'too_many_files'],
  ];
  for (const [body, code] of cases) {
    const r = await call('POST', '/api/send', { token, body });
    assert.equal(r.json.code, code, JSON.stringify(body).slice(0, 80));
    assert.ok(r.status >= 400 && r.status < 500);
  }
  assert.equal(channel.sent.length, 0);
});

test('files: upload straight to storage, SMS carries the link, recipient downloads', async () => {
  const { call, login, uploadFile, channel, base } = await start();
  const token = await login();
  const file = await uploadFile(token, 'Q3 report.pdf', '%PDF-1.7 fake');
  const r = await call('POST', '/api/send', { token, body: { to: '+919876543210', text: 'the report', files: [file], expiresInDays: 1 } });
  assert.equal(r.status, 200, r.text);
  const { share } = r.json;
  assert.equal(share.mode, 'link');
  assert.equal(channel.sent[0].text, `the report\nFile: Q3 report.pdf\nOpen: ${base}/s/${share.id}`);
  assert.deepEqual(share.files, [{ name: 'Q3 report.pdf', size: 13 }]);
  assert.equal(Date.parse(share.expiresAt) - Date.parse(share.createdAt), 24 * 60 * 60 * 1000);

  const pageRes = await call('GET', `/s/${share.id}`);
  assert.equal(pageRes.status, 200);
  assert.match(pageRes.text, /Q3 report\.pdf/);
  assert.equal(pageRes.headers.get('x-robots-tag'), 'noindex, nofollow');

  const dl = await call('POST', `/s/${share.id}/file/0`);
  assert.equal(dl.status, 303);
  const got = await fetch(base + dl.headers.get('location'));
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'application/pdf');
  assert.equal(await got.text(), '%PDF-1.7 fake');
});

test('upload links are signed, single-use and size-capped', async () => {
  const { call, login, base } = await start();
  const token = await login();
  const r = await call('POST', '/api/upload-url', { token, body: { name: 'a.txt', type: 'text/plain', size: 3 } });
  const tampered = r.json.upload.url.replace('a.txt', 'b.txt');
  assert.equal((await fetch(base + tampered, { method: 'PUT', body: 'abc' })).status, 403);
  assert.equal((await fetch(base + r.json.upload.url, { method: 'PUT', body: 'abc' })).status, 200);
  assert.equal((await fetch(base + r.json.upload.url, { method: 'PUT', body: 'xyz' })).status, 409);
  const big = await call('POST', '/api/upload-url', { token, body: { name: 'big.bin', type: '', size: 26 * 1024 * 1024 } });
  assert.equal(big.status, 413);
});

test('download links expire, and HTML files are never shown as pages', async () => {
  const { call, login, uploadFile, clock, base } = await start();
  const token = await login();
  const file = await uploadFile(token, 'page.html', '<script>alert(1)</script>', 'text/html');
  const { json } = await call('POST', '/api/send', { token, body: { to: '9876543210', files: [file] } });
  const dl = await call('POST', `/s/${json.share.id}/file/0`);
  const got = await fetch(base + dl.headers.get('location'));
  assert.equal(got.headers.get('content-type'), 'application/octet-stream');
  assert.match(got.headers.get('content-disposition'), /^attachment/);
  clock.t += 6 * 60 * 1000;
  assert.equal((await fetch(base + dl.headers.get('location'))).status, 403);
});

test('expired shares show a gone page and refuse downloads; cleanup deletes them', async () => {
  const { call, login, uploadFile, clock, shares } = await start({ cronSecret: 'c'.repeat(20) });
  const token = await login();
  const file = await uploadFile(token, 'a.pdf', 'pdf');
  const { json } = await call('POST', '/api/send', { token, body: { to: '9876543210', text: 'x', files: [file], expiresInDays: 1 } });
  clock.t += 25 * 60 * 60 * 1000;
  assert.equal((await call('GET', `/s/${json.share.id}`)).status, 410);
  assert.equal((await call('POST', `/s/${json.share.id}/file/0`)).status, 410);
  assert.equal((await call('GET', '/api/cron/cleanup')).status, 401);
  const swept = await call('GET', '/api/cron/cleanup', { headers: { Authorization: `Bearer ${'c'.repeat(20)}` } });
  assert.deepEqual(swept.json, { removed: 1 });
  assert.equal(await shares.get(json.share.id), null);
  assert.equal((await call('GET', `/s/${json.share.id}`)).status, 404);
});

test('status polling moves a message to delivered and history lists it', async () => {
  const { call, login } = await start();
  const token = await login();
  const { json } = await call('POST', '/api/send', { token, body: { to: '9876543210', text: 'hi' } });
  const s = await call('GET', `/api/shares/${json.share.id}/status`, { token });
  assert.equal(s.json.share.status, 'delivered');
  const h = await call('GET', '/api/history', { token });
  assert.equal(h.json.shares[0].id, json.share.id);
  assert.equal(h.json.shares[0].status, 'delivered');
  assert.equal('providerMessageId' in h.json.shares[0], false);
  assert.equal('id' in h.json.shares[0].files, false);
});

test('a phone that is offline is reported clearly and the share is marked failed', async () => {
  const offline = {
    id: 'sms', provider: 'test',
    async send() { throw new ChannelError('phone_offline', 'Your phone isn’t taking messages right now.', { status: 503 }); },
    async status() { return { status: 'failed' }; },
  };
  const { call, login } = await start({ sms: offline });
  const token = await login();
  const r = await call('POST', '/api/send', { token, body: { to: '9876543210', text: 'hi' } });
  assert.equal(r.status, 503);
  assert.equal(r.json.code, 'phone_offline');
  assert.equal(r.json.share.status, 'failed');
  assert.match(r.json.share.error, /phone/);
});

test('the daily limit stops sending until midnight in India', async () => {
  const { call, login, clock } = await start({ dailyLimit: 2 });
  const token = await login();
  const send = () => call('POST', '/api/send', { token, body: { to: '9876543210', text: 'hi' } });
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  const third = await send();
  assert.equal(third.status, 429);
  assert.equal(third.json.code, 'daily_limit');
  clock.t = Date.parse('2026-10-18T18:31:00Z'); // 00:01 on 19 Oct in India
  assert.equal((await send()).status, 200);
});

test('startOfDayIST', () => {
  assert.equal(startOfDayIST(new Date('2026-10-18T06:00:00Z')), '2026-10-17T18:30:00.000Z');
  assert.equal(startOfDayIST(new Date('2026-10-18T18:29:59Z')), '2026-10-17T18:30:00.000Z');
  assert.equal(startOfDayIST(new Date('2026-10-18T18:30:00Z')), '2026-10-18T18:30:00.000Z');
});

test('cross-site POSTs are refused', async () => {
  const { call, login } = await start();
  const token = await login();
  const r = await call('POST', '/api/send', { token, body: { to: '9876543210', text: 'hi' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('local mode (no passcode) needs no sign-in; a deployment without one refuses to work', async () => {
  const local = await start({ passcode: '' });
  assert.equal((await local.call('POST', '/api/send', { body: { to: '9876543210', text: 'hi' } })).status, 200);
  const deployed = await start({ passcode: '', requireAuth: true, setupMissing: ['APP_PASSCODE'] });
  const cfg = await deployed.call('GET', '/api/public/config');
  assert.deepEqual(cfg.json.setupMissing, ['APP_PASSCODE']);
  assert.equal((await deployed.call('POST', '/api/send', { body: { to: '9876543210', text: 'hi' } })).status, 503);
  assert.equal((await deployed.call('GET', '/s/AAAAAAAAAA')).status, 503);
});
