// End-to-end API tests: the real handler on a real HTTP port, with file
// storage in a temp folder, local files and the dry-run SMS channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHandler, startOfDayIST, dayIST } from '../lib/app.js';
import { createSessions, createLoginLimiter } from '../lib/auth.js';
import { createChannels } from '../lib/channels/index.js';
import { consoleSms } from '../lib/channels/console.js';
import { ChannelError } from '../lib/channels/sms-gate.js';
import { fileShares } from '../lib/shares.js';
import { fileRooms } from '../lib/rooms.js';
import { localFiles } from '../lib/files.js';
import { createRateLimiter } from '../lib/limits.js';
import { newPairing, sealJson, openJson } from '../public/js/pair.js';

const quiet = { log() {}, warn() {}, error() {} };
const PASSCODE = 'open-sesame';

async function start({
  passcode = PASSCODE, sms, dailyLimit = 50, cronSecret = '', requireAuth = false, setupMissing = [],
  limits = {}, publicMax = 1000, gateway = true,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmbasap-test-'));
  const clock = { t: Date.parse('2026-10-18T06:00:00Z') };
  const now = () => new Date(clock.t);
  const channel = gateway ? sms || consoleSms({ log: quiet }) : null;
  const auth = passcode ? { passcode, sessions: createSessions({ secret: 's'.repeat(40), now: () => clock.t }) } : {};
  const shares = fileShares(dir);
  const rooms = fileRooms(dir);
  const files = localFiles({ dir: path.join(dir, 'files'), secret: 'k'.repeat(32), now: () => clock.t });
  const handle = createHandler({
    publicDir: null, auth, shares, rooms, files, channels: createChannels({ sms: channel }), dailyLimit, cronSecret,
    requireAuth, setupMissing, log: quiet, now, limiter: createLoginLimiter({ max: 3, now: () => clock.t }),
    publicLimiter: createRateLimiter({ max: publicMax, windowMs: 60_000, now: () => clock.t }),
    ...limits,
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
  async function uploadFile({ token, roomId } = {}, name = 'a.pdf', content = '%PDF', type = 'application/pdf') {
    const r = await call('POST', '/api/upload-url', { token, body: { name, type, size: Buffer.byteLength(content), roomId } });
    assert.equal(r.status, 200, r.text);
    const put = await fetch(base + r.json.upload.url, { method: 'PUT', body: content, headers: r.json.upload.headers });
    assert.equal(put.status, 200);
    return { id: r.json.fileId, name, type, size: Buffer.byteLength(content) };
  }
  test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { call, login, uploadFile, clock, channel, shares, rooms, base };
}

// ------------------------------------------------------------------ config

test('config is public: WhatsApp and SMS via the phone for everyone, Auto SMS for the owner', async () => {
  const { call } = await start();
  const r = await call('GET', '/api/public/config');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.channels.map((c) => [c.id, c.enabled]), [['whatsapp', true], ['sms', true], ['auto-sms', true], ['email', false]]);
  assert.deepEqual(r.json.owner, { available: true, signInRequired: true, provider: 'console' });
  assert.equal(r.json.limits.maxFileBytes, 100 * 1024 * 1024);
});

test('without the phone gateway, Auto SMS is off and owner routes do not exist', async () => {
  const { call, login } = await start({ gateway: false });
  const r = await call('GET', '/api/public/config');
  assert.equal(r.json.owner.available, false);
  assert.equal(r.json.channels.find((c) => c.id === 'auto-sms').enabled, false);
  const token = await login();
  assert.equal((await call('POST', '/api/send', { token, body: { to: '9876543210', text: 'hi' } })).status, 404);
});

// ------------------------------------------------------------- owner sign-in

test('owner routes need the passcode session; pairing routes do not', async () => {
  const { call } = await start();
  for (const [m, u] of [['GET', '/api/me'], ['GET', '/api/history'], ['POST', '/api/send'], ['GET', '/api/shares/AAAAAAAAAA/status']]) {
    assert.equal((await call(m, u, { body: m === 'POST' ? {} : undefined })).status, 401, `${m} ${u}`);
  }
  assert.equal((await call('GET', '/api/me', { token: 'forged.token.here' })).status, 401);
  const { roomId } = newPairing();
  assert.equal((await call('GET', `/api/rooms/${roomId}?side=laptop`)).status, 200);
});

test('wrong passcodes are refused, and repeated guesses get locked out', async () => {
  const { call, clock } = await start();
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/login', { body: { passcode: 'nope' } })).status, 401);
  assert.equal((await call('POST', '/api/login', { body: { passcode: PASSCODE } })).status, 429);
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

// ---------------------------------------------------------- pair your phone

test('pairing: the laptop drops an encrypted message, the phone picks it up, status moves forward only', async () => {
  const { call, clock } = await start();
  const p = newPairing();
  assert.equal((await call('GET', `/api/rooms/${p.roomId}?side=phone`)).json.room, null, 'polling never creates rooms');
  const created = await call('POST', `/api/rooms/${p.roomId}`, { body: {} });
  assert.equal(created.json.room.phoneSeenAt, null);

  const payload = { v: 1, channel: 'whatsapp', to: '+919876543210', text: 'hello from the laptop', files: [], link: '' };
  const sealed = await sealJson(p.key, payload);
  const sent = await call('POST', `/api/rooms/${p.roomId}/messages`, { body: { id: 'Msg0000001', ...sealed, fileIds: [] } });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.message.status, 'waiting');
  assert.ok(!sent.text.includes('hello'), 'the server never sees the text');

  clock.t += 1000;
  const listed = await call('GET', `/api/rooms/${p.roomId}/messages?since=`);
  assert.equal(listed.json.messages.length, 1);
  assert.deepEqual(await openJson(p.key, listed.json.messages[0]), payload);

  const laptopView = await call('GET', `/api/rooms/${p.roomId}/messages/Msg0000001`);
  assert.equal(laptopView.json.message.status, 'waiting');
  assert.ok(laptopView.json.phoneSeenAt, 'polling marks the phone as paired');

  assert.equal((await call('POST', `/api/rooms/${p.roomId}/messages/Msg0000001/status`, { body: { status: 'opened' } })).json.status, 'opened');
  assert.equal((await call('POST', `/api/rooms/${p.roomId}/messages/Msg0000001/status`, { body: { status: 'received' } })).json.status, 'opened');
  assert.equal((await call('POST', `/api/rooms/${p.roomId}/messages/Msg0000001/status`, { body: { status: 'waiting' } })).status, 400);

  const since = await call('GET', `/api/rooms/${p.roomId}/messages?since=${encodeURIComponent(listed.json.messages[0].createdAt)}`);
  assert.equal(since.json.messages.length, 0);
});

test('a retried send with the same id is accepted once', async () => {
  const { call } = await start();
  const p = newPairing();
  const sealed = await sealJson(p.key, { text: 'x' });
  const body = { id: 'Msg0000002', ...sealed, fileIds: [] };
  assert.equal((await call('POST', `/api/rooms/${p.roomId}/messages`, { body })).status, 200);
  const again = await call('POST', `/api/rooms/${p.roomId}/messages`, { body });
  assert.equal(again.json.duplicate, true);
  assert.equal((await call('GET', `/api/rooms/${p.roomId}/messages`)).json.messages.length, 1);
});

test('malformed room messages are refused', async () => {
  const { call } = await start();
  const p = newPairing();
  const sealed = await sealJson(p.key, { text: 'x' });
  const cases = [
    { id: 'short', ...sealed },
    { id: 'Msg0000003', iv: 'not-sixteen', data: sealed.data },
    { id: 'Msg0000003', iv: sealed.iv, data: 'a'.repeat(50 * 1024) },
    { id: 'Msg0000003', iv: sealed.iv, data: 'has spaces!' },
    { id: 'Msg0000003', ...sealed, fileIds: ['mmbasap/AAAAAAAAAAAAAAAA/x.pdf'] },
  ];
  for (const body of cases) assert.equal((await call('POST', `/api/rooms/${p.roomId}/messages`, { body })).status, 400, JSON.stringify(body).slice(0, 60));
  assert.equal((await call('GET', '/api/rooms/not-a-room/messages')).status, 404);
});

test('files: upload for a room, the phone downloads them, other rooms cannot', async () => {
  const { call, uploadFile, base } = await start();
  const p = newPairing();
  const other = newPairing();
  const file = await uploadFile({ roomId: p.roomId }, 'clip.mp4', 'fake-video-bytes', 'video/mp4');

  const sealed = await sealJson(p.key, { files: [file] });
  assert.equal((await call('POST', `/api/rooms/${p.roomId}/messages`, { body: { id: 'Msg0000004', ...sealed, fileIds: [file.id] } })).status, 200);
  assert.equal((await call('POST', `/api/rooms/${other.roomId}/messages`, { body: { id: 'Msg0000004', ...sealed, fileIds: [file.id] } })).status, 400);

  const got = await call('GET', `/api/rooms/${p.roomId}/file?f=${encodeURIComponent(file.id)}`);
  assert.equal(got.status, 200);
  const bytes = await fetch(base + got.json.url);
  assert.equal(await bytes.text(), 'fake-video-bytes');
  assert.equal((await call('GET', `/api/rooms/${other.roomId}/file?f=${encodeURIComponent(file.id)}`)).status, 404);
});

test('links: a download page for room files (SMS, or when WhatsApp can’t take the file)', async () => {
  const { call, uploadFile, base, rooms, clock } = await start();
  const p = newPairing();
  const file = await uploadFile({ roomId: p.roomId }, 'report.docx', 'docx-bytes', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal((await call('POST', '/api/links', { body: { roomId: newPairing().roomId, files: [file] } })).status, 400, 'someone else’s file');

  const r = await call('POST', '/api/links', { body: { roomId: p.roomId, files: [file], expiresInDays: 7 } });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.link, new RegExp(`^${base}/s/[A-Za-z0-9]{10}$`));
  assert.equal(Date.parse((await rooms.getUpload(file.id)).expiresAt) - clock.t, 7 * 24 * 60 * 60 * 1000, 'the file lives as long as its link');

  const page = await call('GET', new URL(r.json.link).pathname);
  assert.equal(page.status, 200);
  assert.match(page.text, /report\.docx/);
  const dl = await call('POST', `${new URL(r.json.link).pathname}/file/0`);
  assert.equal(dl.status, 303);
  assert.equal(await (await fetch(base + dl.headers.get('location'))).text(), 'docx-bytes');
});

test('public uploads need a pairing and fit in the stored-bytes budgets; the owner is exempt', async () => {
  const { call, uploadFile, login, clock } = await start({ limits: { publicStorageBytes: 150, roomStorageBytes: 100 } });
  const p = newPairing();
  const q = newPairing();
  assert.equal((await call('POST', '/api/upload-url', { body: { name: 'a.pdf', type: 'application/pdf', size: 10 } })).status, 400);
  await uploadFile({ roomId: p.roomId }, 'a.bin', 'x'.repeat(60), 'application/octet-stream');
  const roomFull = await call('POST', '/api/upload-url', { body: { name: 'b.bin', type: '', size: 60, roomId: p.roomId } });
  assert.equal(roomFull.json.code, 'upload_budget', 'one pairing can’t take more than its share');
  await uploadFile({ roomId: q.roomId }, 'c.bin', 'x'.repeat(80), 'application/octet-stream');
  const allFull = await call('POST', '/api/upload-url', { body: { name: 'd.bin', type: '', size: 20, roomId: newPairing().roomId } });
  assert.equal(allFull.json.code, 'upload_budget');
  const token = await login();
  await uploadFile({ token }, 'owner.bin', 'x'.repeat(500), 'application/octet-stream');
  clock.t += 21 * 60 * 1000; // unused uploads expire after 20 minutes and are cleared when space is needed
  await uploadFile({ roomId: p.roomId }, 'e.bin', 'x'.repeat(90), 'application/octet-stream');
});

test('an upload can’t be bigger than the size it declared', async () => {
  const { call, base } = await start();
  const p = newPairing();
  const r = await call('POST', '/api/upload-url', { body: { name: 'small.txt', type: 'text/plain', size: 3, roomId: p.roomId } });
  assert.equal((await fetch(base + r.json.upload.url, { method: 'PUT', body: 'way more than three bytes' })).status, 413);
  assert.equal((await fetch(base + r.json.upload.url, { method: 'PUT', body: 'abc' })).status, 200);
});

test('file ids are a random folder plus a safe version of the name', async () => {
  const { call } = await start();
  const r = await call('POST', '/api/upload-url', { body: { name: '../Salary slip Oct?.PDF', type: 'application/pdf', size: 3, roomId: newPairing().roomId } });
  assert.match(r.json.fileId, /^mmbasap\/[A-Za-z0-9]{16}\/Salary-slip-Oct-.PDF$/);
});

test('parallel uploads can’t get past the storage budget (reserve, then check)', async () => {
  const { call } = await start({ limits: { publicStorageBytes: 250, roomStorageBytes: 1000, addressStorageBytes: 1000 } });
  const results = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/api/upload-url', {
    body: { name: 'a.bin', type: '', size: 100, roomId: newPairing().roomId },
  })));
  const ok = results.filter((r) => r.status === 200).length;
  assert.ok(ok <= 2, `${ok} reservations of 100 bytes fit in 250`);
});

test('expired but undeleted files still count, until an upload request clears them', async () => {
  const { call, uploadFile, clock, rooms } = await start({ limits: { publicStorageBytes: 100, roomStorageBytes: 100, addressStorageBytes: 100 } });
  const p = newPairing();
  const f = await uploadFile({ roomId: p.roomId }, 'a.bin', 'x'.repeat(90), 'application/octet-stream');
  clock.t += 21 * 60 * 1000; // the unused reservation has expired, but nothing deleted it yet
  assert.equal(await rooms.storedBytes(), 90);
  await uploadFile({ roomId: p.roomId }, 'b.bin', 'x'.repeat(90), 'application/octet-stream'); // sweeps a.bin first
  assert.equal(await rooms.getUpload(f.id), null);
});

test('one address can only store so much', async () => {
  const { call, uploadFile } = await start({ limits: { publicStorageBytes: 1000, roomStorageBytes: 1000, addressStorageBytes: 100 } });
  await uploadFile({ roomId: newPairing().roomId }, 'a.bin', 'x'.repeat(80), 'application/octet-stream');
  const r = await call('POST', '/api/upload-url', { body: { name: 'b.bin', type: '', size: 30, roomId: newPairing().roomId } });
  assert.equal(r.json.code, 'upload_budget');
});

test('a message can’t revive a reservation that expired or was never uploaded', async () => {
  const { call, clock, uploadFile } = await start();
  const p = newPairing();
  const never = await call('POST', '/api/upload-url', { body: { name: 'x.bin', type: '', size: 5, roomId: p.roomId } });
  const sealed = await sealJson(p.key, {});
  const r1 = await call('POST', `/api/rooms/${p.roomId}/messages`, { body: { id: 'Rev0000001', ...sealed, fileIds: [never.json.fileId] } });
  assert.equal(r1.json.code, 'upload_missing');
  const f = await uploadFile({ roomId: p.roomId });
  clock.t += 21 * 60 * 1000;
  const r2 = await call('POST', `/api/rooms/${p.roomId}/messages`, { body: { id: 'Rev0000002', ...sealed, fileIds: [f.id] } });
  assert.equal(r2.json.code, 'upload_expired');
});

test('the share page’s Download button works even though it sends Origin: null', async () => {
  const { call, uploadFile } = await start();
  const p = newPairing();
  const file = await uploadFile({ roomId: p.roomId });
  const { json } = await call('POST', '/api/links', { body: { roomId: p.roomId, files: [file] } });
  const dl = await call('POST', `${new URL(json.link).pathname}/file/0`, { headers: { Origin: 'null' } });
  assert.equal(dl.status, 303);
  const other = await call('POST', '/api/links', { body: { roomId: p.roomId, files: [file] }, headers: { Origin: 'null' } });
  assert.equal(other.status, 403, 'every other POST still refuses foreign origins');
});

test('a file can be downloaded only a few times a day, and missing files cost nothing', async () => {
  const { call, uploadFile, rooms } = await start();
  const p = newPairing();
  const file = await uploadFile({ roomId: p.roomId });
  const sealed = await sealJson(p.key, {});
  await call('POST', `/api/rooms/${p.roomId}/messages`, { body: { id: 'Few0000001', ...sealed, fileIds: [file.id] } });
  const url = `/api/rooms/${p.roomId}/file?f=${encodeURIComponent(file.id)}`;
  for (let i = 0; i < 5; i++) assert.equal((await call('GET', url)).status, 200);
  assert.equal((await call('GET', url)).json.code, 'download_budget');
  const ghost = await call('POST', '/api/upload-url', { body: { name: 'ghost.bin', type: '', size: 1000, roomId: p.roomId } });
  assert.equal((await call('GET', `/api/rooms/${p.roomId}/file?f=${encodeURIComponent(ghost.json.fileId)}`)).status, 404);
  assert.equal(await rooms.addUsage(`dl:${dayIST(new Date('2026-10-18T06:00:00Z'))}`, 0), 5 * file.size, 'the ghost wasn’t charged');
});

test('linking again can extend a file’s life up to the cap, but never shorten it', async () => {
  const { call, uploadFile, rooms, clock } = await start();
  const p = newPairing();
  const file = await uploadFile({ roomId: p.roomId });
  const created = clock.t;
  await call('POST', '/api/links', { body: { roomId: p.roomId, files: [file], expiresInDays: 7 } });
  await call('POST', '/api/links', { body: { roomId: p.roomId, files: [file], expiresInDays: 1 } });
  const day = 24 * 60 * 60 * 1000;
  assert.equal(Date.parse((await rooms.getUpload(file.id)).expiresAt) - created, 7 * day, 'a 1-day link didn’t cut the 7-day one');
  clock.t += 6 * day;
  await call('POST', '/api/links', { body: { roomId: p.roomId, files: [file], expiresInDays: 7 } });
  assert.equal(Date.parse((await rooms.getUpload(file.id)).expiresAt) - created, 8 * day, 'never past 8 days from upload');
});

test('a pairing holds at most 30 waiting messages', async () => {
  const { call } = await start();
  const p = newPairing();
  for (let i = 0; i < 30; i++) {
    const sealed = await sealJson(p.key, { i });
    assert.equal((await call('POST', `/api/rooms/${p.roomId}/messages`, { body: { id: `Cap${String(i).padStart(7, '0')}`, ...sealed } })).status, 200);
  }
  const sealed = await sealJson(p.key, { i: 31 });
  const over = await call('POST', `/api/rooms/${p.roomId}/messages`, { body: { id: 'Cap0000031', ...sealed } });
  assert.equal(over.json.code, 'too_many_messages');
});

test('downloads count against a daily budget', async () => {
  const { call, uploadFile, clock } = await start({ limits: { publicDailyDownloadBytes: 10 } });
  const p = newPairing();
  const file = await uploadFile({ roomId: p.roomId }, 'a.bin', 'x'.repeat(6), 'application/octet-stream');
  const sealed = await sealJson(p.key, {});
  await call('POST', `/api/rooms/${p.roomId}/messages`, { body: { id: 'Dl00000001', ...sealed, fileIds: [file.id] } });
  const url = `/api/rooms/${p.roomId}/file?f=${encodeURIComponent(file.id)}`;
  assert.equal((await call('GET', url)).status, 200);
  assert.equal((await call('GET', url)).json.code, 'download_budget');
  clock.t = Date.parse('2026-10-18T18:31:00Z'); // tomorrow in India
  assert.equal((await call('GET', url)).status, 200);
});

test('a malformed since is ignored, not a server error', async () => {
  const { call } = await start();
  const p = newPairing();
  assert.equal((await call('GET', `/api/rooms/${p.roomId}/messages?since=2026-99-99T99:99:99Z`)).status, 200);
});

test('public routes are rate limited per address', async () => {
  const { call } = await start({ publicMax: 2 });
  const p = newPairing();
  const sealed = await sealJson(p.key, { text: 'x' });
  assert.equal((await call('POST', `/api/rooms/${p.roomId}/messages`, { body: { id: 'Msg0000005', ...sealed } })).status, 200);
  assert.equal((await call('POST', `/api/rooms/${p.roomId}/messages`, { body: { id: 'Msg0000006', ...sealed } })).status, 200);
  assert.equal((await call('POST', `/api/rooms/${p.roomId}/messages`, { body: { id: 'Msg0000007', ...sealed } })).status, 429);
});

test('upload links are signed, single-use and size-capped', async () => {
  const { call, base } = await start();
  const p = newPairing();
  const r = await call('POST', '/api/upload-url', { body: { name: 'a.txt', type: 'text/plain', size: 3, roomId: p.roomId } });
  const tampered = r.json.upload.url.replace(/f=[^&]+/, `f=${encodeURIComponent('mmbasap/AAAAAAAAAAAAAAAA/file.txt')}`);
  assert.equal((await fetch(base + tampered, { method: 'PUT', body: 'abc' })).status, 403);
  assert.equal((await fetch(base + r.json.upload.url, { method: 'PUT', body: 'abc' })).status, 200);
  assert.equal((await fetch(base + r.json.upload.url, { method: 'PUT', body: 'xyz' })).status, 409);
  const big = await call('POST', '/api/upload-url', { body: { name: 'big.bin', type: '', size: 101 * 1024 * 1024, roomId: p.roomId } });
  assert.equal(big.status, 413);
});

test('without CRON_SECRET cleanup still runs (it only deletes what has expired)', async () => {
  const { call } = await start();
  const r = await call('GET', '/api/cron/cleanup');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { removed: 0, files: 0, problems: [] });
});

test('cleanup removes expired messages, uploads and their files', async () => {
  const { call, uploadFile, clock, rooms } = await start({ cronSecret: 'c'.repeat(20) });
  const p = newPairing();
  const file = await uploadFile({ roomId: p.roomId }, 'a.pdf', 'pdf');
  const sealed = await sealJson(p.key, { text: 'x' });
  await call('POST', `/api/rooms/${p.roomId}/messages`, { body: { id: 'Msg0000008', ...sealed, fileIds: [file.id] } });
  clock.t += 25 * 60 * 60 * 1000;
  assert.equal((await call('GET', '/api/cron/cleanup')).status, 401);
  const swept = await call('GET', '/api/cron/cleanup', { headers: { Authorization: `Bearer ${'c'.repeat(20)}` } });
  assert.equal(swept.json.files, 1);
  assert.equal(await rooms.getUpload(file.id), null);
  assert.equal((await call('GET', `/api/rooms/${p.roomId}/messages`)).json.messages.length, 0);
  assert.equal((await call('GET', `/api/rooms/${p.roomId}/file?f=${encodeURIComponent(file.id)}`)).status, 404);
});

// ---------------------------------------------------------- owner: auto SMS

test('auto SMS: short text goes out inline to the normalised number', async () => {
  const { call, login, channel } = await start();
  const token = await login();
  const r = await call('POST', '/api/send', { token, body: { to: '98765 43210', text: '  link: https://example.com/x  ' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.share.to, '+919876543210');
  assert.equal(r.json.share.mode, 'inline');
  assert.deepEqual(channel.sent, [{ to: '+919876543210', text: 'link: https://example.com/x', idempotencyKey: r.json.share.id }]);
});

test('auto SMS: bad input is explained, not sent', async () => {
  const { call, login, channel } = await start();
  const token = await login();
  const cases = [
    [{ to: '12345', text: 'hi' }, 'bad_number'],
    [{ to: '9876543210', text: '   ' }, 'empty'],
    [{ to: '9876543210', text: 'x'.repeat(10_001) }, 'too_long'],
    [{ to: '9876543210', files: [{ id: '../../etc/passwd', name: 'x' }] }, 'bad_request'],
    [{ to: '9876543210', files: [{ id: 'mmbasap/AAAAAAAAAAAAAAAA/never.pdf', name: 'never.pdf' }] }, 'bad_request'],
    [{ to: '9876543210', files: Array.from({ length: 6 }, () => ({ id: 'mmbasap/AAAAAAAAAAAAAAAA/a.pdf' })) }, 'too_many_files'],
  ];
  for (const [body, code] of cases) {
    const r = await call('POST', '/api/send', { token, body });
    assert.equal(r.json.code, code, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(channel.sent.length, 0);
});

test('auto SMS with a file: the SMS carries the link, recipient downloads; expired links are gone', async () => {
  const { call, login, uploadFile, channel, base, clock } = await start();
  const token = await login();
  const file = await uploadFile({ token }, 'Q3 report.pdf', '%PDF-1.7 fake');
  const r = await call('POST', '/api/send', { token, body: { to: '+919876543210', text: 'the report', files: [file], expiresInDays: 1 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(channel.sent[0].text, `the report\nFile: Q3 report.pdf\nOpen: ${base}/s/${r.json.share.id}`);
  const dl = await call('POST', `/s/${r.json.share.id}/file/0`);
  assert.equal(await (await fetch(base + dl.headers.get('location'))).text(), '%PDF-1.7 fake');
  clock.t += 25 * 60 * 60 * 1000;
  assert.equal((await call('GET', `/s/${r.json.share.id}`)).status, 410);
});

test('HTML files are never shown as pages on our own origin', async () => {
  const { call, login, uploadFile, base } = await start();
  const token = await login();
  const file = await uploadFile({ token }, 'page.html', '<script>alert(1)</script>', 'text/html');
  const { json } = await call('POST', '/api/send', { token, body: { to: '9876543210', files: [file] } });
  const dl = await call('POST', `/s/${json.share.id}/file/0`);
  const got = await fetch(base + dl.headers.get('location'));
  assert.equal(got.headers.get('content-type'), 'application/octet-stream');
  assert.match(got.headers.get('content-disposition'), /^attachment/);
});

test('auto SMS: status polling and history', async () => {
  const { call, login } = await start();
  const token = await login();
  const { json } = await call('POST', '/api/send', { token, body: { to: '9876543210', text: 'hi' } });
  assert.equal((await call('GET', `/api/shares/${json.share.id}/status`, { token })).json.share.status, 'delivered');
  const h = await call('GET', '/api/history', { token });
  assert.equal(h.json.shares[0].id, json.share.id);
  assert.equal('providerMessageId' in h.json.shares[0], false);
});

test('auto SMS: an offline phone is reported clearly and the share is marked failed', async () => {
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
});

test('auto SMS: the daily limit stops sending until midnight in India, and link pages don’t count', async () => {
  const { call, login, clock, uploadFile } = await start({ dailyLimit: 2 });
  const token = await login();
  const p = newPairing();
  const f = await uploadFile({ roomId: p.roomId });
  await call('POST', '/api/links', { body: { roomId: p.roomId, files: [f] } });
  const send = () => call('POST', '/api/send', { token, body: { to: '9876543210', text: 'hi' } });
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  assert.equal((await send()).json.code, 'daily_limit');
  clock.t = Date.parse('2026-10-18T18:31:00Z');
  assert.equal((await send()).status, 200);
});

// ------------------------------------------------------------------ general

test('IST day helpers', () => {
  assert.equal(startOfDayIST(new Date('2026-10-18T06:00:00Z')), '2026-10-17T18:30:00.000Z');
  assert.equal(startOfDayIST(new Date('2026-10-18T18:30:00Z')), '2026-10-18T18:30:00.000Z');
  assert.equal(dayIST(new Date('2026-10-18T18:29:00Z')), '2026-10-18');
  assert.equal(dayIST(new Date('2026-10-18T18:31:00Z')), '2026-10-19');
});

test('cross-site POSTs are refused', async () => {
  const { call } = await start();
  const p = newPairing();
  const sealed = await sealJson(p.key, { text: 'x' });
  const r = await call('POST', `/api/rooms/${p.roomId}/messages`, { body: { id: 'Msg0000009', ...sealed }, headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('local mode (no passcode) makes everyone the owner; a deployment missing storage serves nothing', async () => {
  const local = await start({ passcode: '' });
  assert.equal((await local.call('POST', '/api/send', { body: { to: '9876543210', text: 'hi' } })).status, 200);
  const deployed = await start({ passcode: '', requireAuth: true, setupMissing: ['DATABASE_URL'] });
  const cfg = await deployed.call('GET', '/api/public/config');
  assert.deepEqual(cfg.json.setupMissing, ['DATABASE_URL']);
  assert.equal((await deployed.call('GET', `/api/rooms/${newPairing().roomId}`)).status, 503);
  assert.equal((await deployed.call('GET', '/s/AAAAAAAAAA')).status, 503);
});
