// HTTP request handler, shared by the local server (local-server.js) and the
// Vercel function (api/index.js).
//
// Two ways to send:
//  • Pair your phone (anyone, no sign-in): the laptop drops an end-to-end
//    encrypted message into a "room" shared with the user's phone; the phone
//    opens WhatsApp or Messages pre-filled and the user taps Send. The server
//    stores only ciphertext.
//  • Auto SMS (owner only, passcode): the owner's Android phone sends the SMS
//    through SMS Gateway for Android.
//
// Public:
//   GET  /api/public/config                 → { setupMissing, owner, channels, limits, baseUrl }
//   POST /api/login                         → { passcode } in, { token } out
//   POST /api/upload-url                    → { name, type, size, roomId?, expiresInDays } in, { fileId, upload } out
//   POST /api/links                         → { roomId?, files, expiresInDays } in, { link } out (download page for files)
//   POST /api/rooms/:room                   → { room } (the laptop creates its pairing)
//   GET  /api/rooms/:room?side=laptop|phone → { room } (and marks that side as seen)
//   POST /api/rooms/:room/messages          → { id, iv, data, fileIds } in
//   GET  /api/rooms/:room/messages?since=   → { messages } (the phone polls this)
//   GET  /api/rooms/:room/messages/:id      → { message } (the laptop polls status)
//   POST /api/rooms/:room/messages/:id/status → { status: 'received' | 'opened' }
//   GET  /api/rooms/:room/file?f=<fileId>   → { url } short-lived download URL
//   GET  /s/:id, POST /s/:id/file/:n        → the download page behind a link
//   GET  /api/cron/cleanup                  → deletes expired data and files (Vercel cron, CRON_SECRET)
// Owner ("Authorization: Bearer <token>", or anyone in local mode without a passcode):
//   GET  /api/me
//   POST /api/send                          → { to, text, files, expiresInDays } in, { share } out
//   GET  /api/shares/:id/status             → { share } with fresh delivery status
//   GET  /api/history                       → { shares } newest first
// Errors are { code, error: <human text> }.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AuthError, passcodeMatches, createLoginLimiter } from './auth.js';
import { ChannelError } from './channels/index.js';
import { isFileId, MAX_FILE_BYTES, MAX_FILES } from './files.js';
import { randomId, SHARE_ID } from './ids.js';
import { createRateLimiter } from './limits.js';
import { sharePage } from './share-page.js';
import { cleanText, composeSms, normalizePhone, MAX_TEXT } from '../public/js/sms.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const EXPIRY_DAYS = [1, 7];
const FINAL = new Set(['delivered', 'failed']);
const MESSAGE_TTL_MS = DAY_MS;
const UNUSED_UPLOAD_MS = 20 * 60 * 1000; // an upload nobody links or sends is dropped after 20 minutes
const MAX_FILE_LIFE_MS = 8 * DAY_MS;     // nothing keeps a file longer, however often it's re-linked
const MAX_LIVE_MESSAGES = 30;            // per pairing
const DOWNLOADS_PER_FILE = 5;            // download links per file per day
const WRITES_PER_ADDRESS = 400;          // public writes (pairings, messages, uploads, links) per address per day
const ROOM_ID = /^[A-Za-z0-9]{16}$/;
const MESSAGE_ID = /^[A-Za-z0-9]{10}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const MAX_CIPHERTEXT = 48 * 1024; // base64url characters; 10,000 characters of text fit easily

class ApiError extends Error {
  constructor(status, code, error) {
    super(error);
    this.status = status;
    this.body = { code, error };
  }
}

export function send(res, status, body, type = 'application/json') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(payload);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const onData = (c) => {
      size += c.length;
      if (size <= limit) return chunks.push(c);
      // Discard the rest instead of destroying the request, so the 413 reaches the browser.
      req.off('data', onData);
      req.resume();
      chunks.length = 0;
      reject(new ApiError(413, 'too_large', 'That message is too large.'));
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new ApiError(415, 'bad_request', 'JSON only');
  const raw = await readBody(req);
  try {
    const body = JSON.parse(raw);
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw new ApiError(400, 'bad_request', 'Malformed JSON');
  }
}

/** Midnight in India, as an ISO time — the daily limits reset then. */
export function startOfDayIST(now) {
  const t = now.getTime() + IST_OFFSET_MS;
  return new Date(t - (t % DAY_MS) - IST_OFFSET_MS).toISOString();
}
/** Today's date in India, 'YYYY-MM-DD'. */
export const dayIST = (now) => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** What the browser may see of an auto-SMS share (no internal file ids). */
export function publicShare(share, baseUrl) {
  return {
    id: share.id,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    channel: share.channel,
    to: share.to,
    text: share.text,
    body: share.body,
    mode: share.mode,
    status: share.status,
    error: share.error || null,
    files: (share.files || []).map((f) => ({ name: f.name, size: f.size })),
    link: `${baseUrl}/s/${share.id}`,
  };
}

const publicMessage = (m) => ({ id: m.id, createdAt: m.createdAt, expiresAt: m.expiresAt, iv: m.iv, data: m.data, fileIds: m.fileIds, status: m.status });

/**
 * auth:     { passcode, sessions } — the owner's sign-in (auto SMS). No passcode
 *           and no requireAuth = local mode, where everyone is the owner.
 * shares:   lib/shares.js   rooms: lib/rooms.js   files: lib/files.js
 * channels: lib/channels/index.js (the owner's SMS gateway)
 * requireAuth:  owner routes need a session even without a passcode (deployments)
 * setupMissing: settings a deployment needs before it can serve anything
 * baseUrl:  PUBLIC_BASE_URL for links; otherwise taken from the request
 * dailyLimit: auto SMS per day (India time) — protects the owner's SMS pack
 * Free-tier fences for everyone but the owner (Vercel Blob Hobby: 1 GB stored, 10 GB/month out):
 *   publicStorageBytes:  files stored at once, all pairings together
 *   roomStorageBytes:    files stored at once by one pairing
 *   addressStorageBytes: files stored at once from one address
 *   publicDailyDownloadBytes: file downloads per day (India time); the owner's Auto SMS
 *           links have an allowance of their own, so the public can't use it up
 *   messageBytesPerDay:  encrypted message text written per day, all pairings together
 * trustProxy: take the client address from X-Forwarded-For (only behind Vercel's proxy)
 */
export function createHandler({
  publicDir = null, auth = {}, shares, rooms, files, channels, requireAuth = false, setupMissing = [],
  baseUrl = '', dailyLimit = 50, cronSecret = '', log = console,
  publicStorageBytes = 600 * 1024 * 1024, roomStorageBytes = 200 * 1024 * 1024, addressStorageBytes = 200 * 1024 * 1024,
  publicDailyDownloadBytes = 300 * 1024 * 1024, messageBytesPerDay = 50 * 1024 * 1024, trustProxy = false,
  now = () => new Date(), limiter = createLoginLimiter(), globalLoginLimiter = createLoginLimiter({ max: 30 }),
  publicLimiter = createRateLimiter({ max: 120, windowMs: 10 * 60 * 1000 }),
  pollLimiter = createRateLimiter({ max: 600, windowMs: 10 * 60 * 1000 }),
}) {
  const authEnabled = Boolean(auth.passcode && auth.sessions);
  const localMode = !authEnabled && !requireAuth;
  const misconfigured = setupMissing.length > 0;
  const gateway = channels?.get('sms') || null;
  const ownerAvailable = Boolean(gateway) && (authEnabled || localMode);

  // The phone polls every few seconds; only write "last seen" now and then.
  const seenAt = new Map();
  async function markSeen(roomId, side, at) {
    const key = `${roomId}:${side}`;
    const last = seenAt.get(key) || 0;
    if (Date.parse(at) - last < 30_000) return null;
    const room = await rooms.seen(roomId, side, at);
    if (room) { // only throttle once it counted (the laptop may not have registered the room yet)
      seenAt.set(key, Date.parse(at));
      if (seenAt.size > 10_000) seenAt.clear();
    }
    return room;
  }

  const baseOf = (req) => {
    if (baseUrl) return baseUrl.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
    return `${proto}://${req.headers.host}`;
  };
  const clientIp = (req) => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket?.remoteAddress || 'unknown';
  /** A short hash of the address, for per-address quotas stored in the database. */
  const ipKey = (req) => crypto.createHash('sha256').update(`mmbasap:${clientIp(req)}`).digest('base64url').slice(0, 16);

  /** The owner's session, or null. In local mode everyone is the owner. */
  function owner(req) {
    if (localMode) return { local: true, sub: 'owner' };
    if (!authEnabled) return null;
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) return null;
    return auth.sessions.verify(header.slice(7));
  }

  /** Browsers always send Origin on cross-site POSTs; refuse ones from other sites. */
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  function slowDown(req, which = publicLimiter) {
    if (!which.take(clientIp(req))) throw new ApiError(429, 'slow_down', 'Too many requests. Wait a few minutes and try again.');
  }

  /** Adds to a usage counter and undoes it if that passes the limit (counters end in the date, so they reset daily). */
  async function spend(key, amount, limit, error) {
    const total = await rooms.addUsage(key, amount);
    if (total > limit) {
      await rooms.addUsage(key, -amount);
      throw new ApiError(429, error.code, error.text);
    }
  }
  /** Public writes per address per day, kept in the database so every server instance agrees. */
  async function countWrite(req, at) {
    await spend(`w:${ipKey(req)}:${dayIST(at)}`, 1, WRITES_PER_ADDRESS, { code: 'slow_down', text: 'Too many sends from this network today. Try again tomorrow.' });
  }
  /**
   * Charges a download: at most DOWNLOADS_PER_FILE links per file per day, and
   * the file's size against today's allowance — the owner's Auto SMS links
   * (owner: true) against their own allowance, so the public can't block them.
   */
  async function spendDownload(fileId, bytes, at, { owner: ownerFile = false } = {}) {
    const day = dayIST(at);
    await spend(`dlf:${fileId}:${day}`, 1, DOWNLOADS_PER_FILE, { code: 'download_budget', text: 'This file has been downloaded a lot today. Try again tomorrow.' });
    await spend(`${ownerFile ? 'dlo' : 'dl'}:${day}`, bytes, publicDailyDownloadBytes, {
      code: 'download_budget', text: 'This MMBASAP has used today’s free download allowance. The file will be available again tomorrow.',
    });
  }

  /** Deletes up to `limit` expired uploads (files first, then their records). Returns how many. */
  async function sweepUploads(at, limit) {
    const ids = await rooms.expiredUploads(at, limit);
    if (!ids.length) return 0;
    await files.remove(ids);
    await rooms.removeUploads(ids);
    return ids.length;
  }
  const fileCap = (upload) => new Date(Date.parse(upload.createdAt) + MAX_FILE_LIFE_MS).toISOString();

  // ------------------------------------------------------------ owner sign-in
  async function login(req, res) {
    if (!authEnabled) return send(res, 400, { code: 'bad_request', error: 'Owner sign-in isn’t set up on this server.' });
    const ip = clientIp(req);
    if (limiter.blocked(ip) || globalLoginLimiter.blocked('all')) return send(res, 429, { code: 'too_many_attempts', error: 'Too many wrong passcodes. Wait 15 minutes and try again.' });
    const { passcode } = await readJson(req);
    if (!passcodeMatches(passcode, auth.passcode)) {
      limiter.fail(ip);
      globalLoginLimiter.fail('all'); // changing addresses doesn't buy more guesses
      log.warn?.(`[auth] wrong passcode from ${ip}`);
      return send(res, 401, { code: 'wrong_passcode', error: 'That passcode isn’t right.' });
    }
    limiter.reset(ip);
    return send(res, 200, { token: auth.sessions.issue({ sub: 'owner', name: 'Owner' }) });
  }

  // ------------------------------------------------------------------ files
  const expiryOf = (days) => (EXPIRY_DAYS.includes(days) ? days : 1);

  async function uploadUrl(req, res) {
    const isOwner = Boolean(owner(req));
    if (!isOwner) slowDown(req);
    const { name, type, size, roomId } = await readJson(req);
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new ApiError(400, 'bad_request', 'The file needs a name.');
    if (!(Number.isInteger(size) && size > 0)) throw new ApiError(400, 'bad_request', 'That file is empty.');
    if (size > MAX_FILE_BYTES) throw new ApiError(413, 'too_large', `Files can be up to ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
    if (roomId != null && !ROOM_ID.test(roomId)) throw new ApiError(400, 'bad_request', 'Unknown pairing.');
    if (!isOwner && !roomId) throw new ApiError(400, 'bad_request', 'Pair your phone first.');

    const at = now();
    const atIso = at.toISOString();
    if (!isOwner) await countWrite(req, at);
    const mime = typeof type === 'string' && type.length <= 100 ? type : '';
    const fileId = files.newFileId(name);
    const ip = isOwner ? null : ipKey(req);
    // Reserve first, then check: concurrent requests can only be refused too eagerly, never let past.
    await rooms.putUpload({
      fileId, roomId: roomId || null, size, owner: isOwner, ip,
      // Unused uploads go after 20 minutes; sending or a link gives them their real life.
      createdAt: atIso, expiresAt: new Date(at.getTime() + UNUSED_UPLOAD_MS).toISOString(),
    });
    if (!isOwner) {
      // Budgets count every file still stored (expired ones too, until they're deleted).
      const over = async () => {
        if (await rooms.storedBytes({ roomId }) > roomStorageBytes) return 'You’ve got a lot of files waiting already. Send or remove some, or try again in a little while.';
        if (await rooms.storedBytes({ ip }) > addressStorageBytes) return 'Your network has a lot of files waiting already. Try again in a little while.';
        if (await rooms.storedBytes() > publicStorageBytes) return 'This MMBASAP’s free file space is full right now. Try again later, or send text only.';
        return null;
      };
      let problem = await over();
      if (problem && await sweepUploads(atIso, 50)) problem = await over(); // free what has expired, then look again
      if (problem) {
        await rooms.removeUploads([fileId]);
        throw new ApiError(429, 'upload_budget', problem);
      }
    }
    // The URL accepts at most the declared size, so the budget can't be dodged.
    return send(res, 200, { fileId, upload: await files.uploadTarget({ fileId, type: mime, size }) });
  }

  /** Checks attached files: known uploads, from this room (or the owner's), uploaded and unexpired. */
  async function validFiles(list, { roomId = null, isOwner = false } = {}) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw new ApiError(400, 'bad_request', 'files must be a list.');
    if (list.length > MAX_FILES) throw new ApiError(400, 'too_many_files', `You can attach up to ${MAX_FILES} files.`);
    const out = [];
    const at = now().toISOString();
    for (const f of list) {
      if (!f || !isFileId(f.id)) throw new ApiError(400, 'bad_request', 'Unknown file.');
      const upload = await rooms.getUpload(f.id);
      const mine = upload && (isOwner || (roomId && upload.roomId === roomId));
      const label = String(f.name || 'A file').slice(0, 80);
      if (!mine) throw new ApiError(400, 'bad_request', 'Unknown file.');
      if (upload.expiresAt < at) throw new ApiError(410, 'upload_expired', `“${label}” was attached a while ago and has expired. Attach it again.`);
      if (!(await files.exists(f.id))) throw new ApiError(400, 'upload_missing', `“${label}” didn’t finish uploading. Attach it again.`);
      out.push({
        id: f.id,
        name: String(f.name || f.id.split('/').pop()).slice(0, 200),
        type: typeof f.type === 'string' ? f.type.slice(0, 100) : '',
        size: upload.size,
        upload,
      });
    }
    return out;
  }

  /** A download page for files, for SMS (which can't carry files) and as a WhatsApp fallback. */
  async function createLink(req, res) {
    const isOwner = Boolean(owner(req));
    if (!isOwner) slowDown(req);
    const body = await readJson(req);
    const roomId = body.roomId ?? null;
    if (!isOwner) await countWrite(req, now());
    if (roomId != null && !ROOM_ID.test(roomId)) throw new ApiError(400, 'bad_request', 'Unknown pairing.');
    const attached = await validFiles(body.files, { roomId, isOwner });
    if (!attached.length) throw new ApiError(400, 'empty', 'Attach a file first.');
    const at = now();
    const wanted = new Date(at.getTime() + expiryOf(body.expiresInDays) * DAY_MS).toISOString();
    let expiresAt = wanted;
    for (const f of attached) {
      const u = await rooms.extendUpload(f.id, wanted, fileCap(f.upload)); // only ever longer, never past the cap
      if (u.expiresAt < expiresAt) expiresAt = u.expiresAt; // the page lives as long as its files
    }
    const id = randomId(10);
    await shares.create({
      id, createdAt: at.toISOString(), expiresAt, channel: 'link', to: '', text: '', roomId, owner: isOwner,
      files: attached.map(({ upload: _u, ...f }) => f), body: '', mode: 'link', status: 'link',
    });
    return send(res, 200, { link: `${baseOf(req)}/s/${id}`, expiresAt });
  }

  // ------------------------------------------------------------------ rooms
  async function roomApi(req, res, url, m) {
    const [, roomId, rest = ''] = m;
    if (!ROOM_ID.test(roomId)) throw new ApiError(404, 'not_found', 'Unknown pairing.');
    const at = now().toISOString();

    if (rest === '' && req.method === 'POST') {
      slowDown(req);
      if (!(await rooms.getRoom(roomId))) await countWrite(req, now());
      return send(res, 200, { room: await rooms.create(roomId, at) });
    }

    if (rest === '' && req.method === 'GET') {
      slowDown(req, pollLimiter);
      const side = url.searchParams.get('side');
      if (side === 'phone' || side === 'laptop') await markSeen(roomId, side, at);
      return send(res, 200, { room: await rooms.getRoom(roomId) });
    }

    if (rest === '/messages' && req.method === 'POST') {
      slowDown(req);
      const { id, iv, data, fileIds = [] } = await readJson(req);
      if (!MESSAGE_ID.test(id || '')) throw new ApiError(400, 'bad_request', 'Bad message id.');
      if (typeof iv !== 'string' || iv.length !== 16 || !B64URL.test(iv)) throw new ApiError(400, 'bad_request', 'Bad message.');
      if (typeof data !== 'string' || !data || data.length > MAX_CIPHERTEXT || !B64URL.test(data)) throw new ApiError(400, 'bad_request', 'Message too large or malformed.');
      if (!Array.isArray(fileIds) || fileIds.length > MAX_FILES) throw new ApiError(400, 'bad_request', 'Too many files.');
      if (await rooms.getMessage(roomId, id)) return send(res, 200, { ok: true, duplicate: true }); // a retried send
      // Same checks as links: this room's, unexpired, actually uploaded.
      const attached = await validFiles(fileIds.map((fileId) => ({ id: fileId })), { roomId });
      if (await rooms.countMessages(roomId, at) >= MAX_LIVE_MESSAGES) {
        throw new ApiError(429, 'too_many_messages', 'Your phone has lots of messages waiting. Open MMBASAP on it first.');
      }
      await countWrite(req, now());
      await spend(`msg:${dayIST(now())}`, data.length, messageBytesPerDay, { code: 'slow_down', text: 'This MMBASAP is very busy today. Try again tomorrow.' });
      await rooms.create(roomId, at);
      const expiresAt = new Date(Date.parse(at) + MESSAGE_TTL_MS).toISOString();
      for (const f of attached) await rooms.extendUpload(f.id, expiresAt, fileCap(f.upload)); // the phone needs them for the day
      const message = await rooms.addMessage({ id, roomId, createdAt: at, expiresAt, iv, data, fileIds, status: 'waiting' });
      return send(res, 200, { message: publicMessage(message) });
    }

    if (rest === '/messages' && req.method === 'GET') {
      slowDown(req, pollLimiter);
      await markSeen(roomId, 'phone', at);
      const raw = url.searchParams.get('since') || '';
      const since = /^\d{4}-\d\d-\d\dT/.test(raw) ? Date.parse(raw) : NaN;
      const sinceIso = Number.isFinite(since) && since >= 0 && since < 253402300800000 ? new Date(since).toISOString() : '';
      const list = await rooms.listMessages(roomId, sinceIso, at);
      return send(res, 200, { messages: list.map(publicMessage), now: at, more: list.length === 10 });
    }

    const one = rest.match(/^\/messages\/([A-Za-z0-9]{10})(\/status)?$/);
    if (one && !one[2] && req.method === 'GET') {
      slowDown(req, pollLimiter);
      const message = await rooms.getMessage(roomId, one[1]);
      if (!message || message.expiresAt <= at) throw new ApiError(404, 'not_found', 'No such message.');
      const room = await rooms.getRoom(roomId);
      return send(res, 200, { message: { id: message.id, status: message.status, createdAt: message.createdAt }, phoneSeenAt: room?.phoneSeenAt || null });
    }
    if (one && one[2] && req.method === 'POST') {
      slowDown(req, pollLimiter);
      const { status } = await readJson(req);
      if (status !== 'received' && status !== 'opened') throw new ApiError(400, 'bad_request', 'Unknown status.');
      const message = await rooms.setStatus(roomId, one[1], status);
      if (!message) throw new ApiError(404, 'not_found', 'No such message.');
      return send(res, 200, { status: message.status });
    }

    if (rest === '/file' && req.method === 'GET') {
      slowDown(req);
      const fileId = url.searchParams.get('f') || '';
      const upload = isFileId(fileId) ? await rooms.getUpload(fileId) : null;
      if (!upload || upload.roomId !== roomId || upload.expiresAt < at || !(await files.exists(fileId))) {
        throw new ApiError(404, 'not_found', 'This file is no longer available.');
      }
      await spendDownload(fileId, upload.size, now());
      return send(res, 200, { url: await files.downloadUrl(fileId, { type: '', name: fileId.split('/').pop() }) });
    }
    return send(res, 404, { code: 'not_found', error: 'Not found' });
  }

  // ------------------------------------------------------- owner: auto SMS
  async function sendShare(req, res) {
    const body = await readJson(req);
    const phone = normalizePhone(body.to);
    if (!phone.ok) throw new ApiError(400, 'bad_number', phone.error);
    const text = cleanText(body.text);
    if (text.length > MAX_TEXT) throw new ApiError(400, 'too_long', `Text can be up to ${MAX_TEXT.toLocaleString('en-IN')} characters.`);
    const checked = await validFiles(body.files, { isOwner: true });
    const attached = checked.map(({ upload: _u, ...f }) => f);
    if (!text && !attached.length) throw new ApiError(400, 'empty', 'Write something or attach a file first.');

    const at = now();
    const sentToday = await shares.countSince(startOfDayIST(at), 'sms');
    if (sentToday >= dailyLimit) throw new ApiError(429, 'daily_limit', `You’ve sent ${dailyLimit} messages today — the limit resets at midnight.`);

    const days = EXPIRY_DAYS.includes(body.expiresInDays) ? body.expiresInDays : 7;
    let expiresAt = new Date(at.getTime() + days * DAY_MS).toISOString();
    for (const f of checked) {
      const u = await rooms.extendUpload(f.id, expiresAt, fileCap(f.upload));
      if (u && u.expiresAt < expiresAt) expiresAt = u.expiresAt; // the page can't outlive its files
    }
    const id = randomId(10);
    const base = baseOf(req);
    const sms = composeSms({ text, files: attached, link: `${base}/s/${id}` });
    let share = await shares.create({
      id,
      createdAt: at.toISOString(),
      expiresAt,
      channel: 'sms',
      to: phone.e164,
      text,
      files: attached,
      body: sms.body,
      mode: sms.mode,
      status: 'sending',
    });
    try {
      const result = await gateway.send({ to: phone.e164, text: sms.body, idempotencyKey: id });
      share = await shares.update(id, { status: result.status, providerMessageId: result.providerMessageId });
    } catch (err) {
      if (!(err instanceof ChannelError)) throw err;
      log.warn?.(`[send] ${id}: ${err.code} ${err.message}`);
      share = await shares.update(id, { status: 'failed', error: err.message, errorCode: err.code });
      return send(res, err.status, { code: err.code, error: err.message, share: publicShare(share, base) });
    }
    return send(res, 200, { share: publicShare(share, base) });
  }

  async function refreshStatus(req, res, id) {
    let share = await shares.get(id);
    if (!share || share.channel !== 'sms') throw new ApiError(404, 'not_found', 'No such message.');
    if (share.providerMessageId && !FINAL.has(share.status)) {
      try {
        const fresh = await gateway.status(share.providerMessageId);
        if (fresh.status !== share.status) share = await shares.update(id, { status: fresh.status, error: fresh.error || null });
      } catch (err) {
        if (!(err instanceof ChannelError)) throw err;
        return send(res, 200, { share: publicShare(share, baseOf(req)), checkError: err.message });
      }
    }
    return send(res, 200, { share: publicShare(share, baseOf(req)) });
  }

  // ---------------------------------------------------------------- cleanup
  async function cleanup(req, res) {
    // Cleanup only deletes what has already expired, so without CRON_SECRET it
    // stays open (rate limited); with it, only Vercel's cron may run it.
    if (cronSecret && String(req.headers.authorization || '') !== `Bearer ${cronSecret}`) {
      return send(res, 401, { code: 'unauthorized', error: 'Authentication required' });
    }
    if (!cronSecret) slowDown(req);
    const at = now().toISOString();
    let removed = 0, filesRemoved = 0;
    const problems = [];
    try {
      // Files first, then their records — a failed delete is retried next run.
      for (let round = 0; round < 50; round++) {
        const n = await sweepUploads(at, 100);
        filesRemoved += n;
        if (!n) break;
      }
    } catch (err) { problems.push(`files: ${err.message}`); }
    try {
      removed = await shares.removeExpired(at); // their files are swept above, by upload expiry
    } catch (err) { problems.push(`shares: ${err.message}`); }
    try { await rooms.purge(at); } catch (err) { problems.push(`rooms: ${err.message}`); }
    if (removed || filesRemoved || problems.length) log.log?.(`[cleanup] ${removed} share(s), ${filesRemoved} file(s)${problems.length ? `; problems: ${problems.join('; ')}` : ''}`);
    return send(res, problems.length ? 500 : 200, { removed, files: filesRemoved, problems });
  }

  // ------------------------------------------------------------ share page
  async function sharePublic(req, res, url) {
    const m = url.pathname.match(/^\/s\/([^/]+)(?:\/file\/(\d+))?\/?$/);
    if (!m) return send(res, 404, 'Not found', 'text/plain');
    if (!pollLimiter.take(clientIp(req))) return send(res, 429, 'Too many requests. Wait a few minutes and try again.', 'text/plain; charset=utf-8');
    const share = SHARE_ID.test(m[1]) ? await shares.get(m[1]) : null;
    if (m[2] === undefined) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
      const { status, html } = sharePage(share, { now: now() });
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed', 'text/plain');
    const file = share?.files?.[Number(m[2])];
    if (!share || !file || new Date(share.expiresAt) <= now()) return send(res, 410, 'This file is no longer available.', 'text/plain; charset=utf-8');
    if (!publicLimiter.take(clientIp(req))) return send(res, 429, 'Too many downloads. Wait a few minutes and try again.', 'text/plain; charset=utf-8');
    try {
      await spendDownload(file.id, file.size || 0, now(), { owner: share.channel === 'sms' || share.owner === true });
    } catch (err) {
      if (err instanceof ApiError) return send(res, 429, err.body.error, 'text/plain; charset=utf-8');
      throw err;
    }
    const target = await files.downloadUrl(file.id, { type: file.type, name: file.name });
    res.writeHead(303, { Location: target, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return res.end();
  }

  // -------------------------------------------------------------------- api
  function config(req) {
    return {
      setupMissing,
      owner: { available: ownerAvailable, signInRequired: authEnabled, provider: gateway?.provider || null },
      channels: [
        { id: 'whatsapp', label: 'WhatsApp', via: 'phone', enabled: true },
        { id: 'sms', label: 'SMS', via: 'phone', enabled: true },
        { id: 'auto-sms', label: 'Auto SMS', via: 'gateway', owner: true, enabled: ownerAvailable },
        { id: 'email', label: 'Gmail', enabled: false, note: 'Soon' },
      ],
      limits: {
        maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxText: MAX_TEXT, dailyLimit, expiryDays: EXPIRY_DAYS,
        publicStorageBytes, roomStorageBytes, publicDailyDownloadBytes, messagePageSize: 10,
      },
      baseUrl: baseOf(req),
      storage: { shares: shares.kind, files: files.kind },
    };
  }

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/public/config') return send(res, 200, config(req));
    if (misconfigured) {
      return send(res, 503, { code: 'not_configured', error: `This deployment isn’t set up yet. Missing: ${setupMissing.join(', ')}.` });
    }
    if (route === 'POST /api/login') return login(req, res);
    if (route === 'GET /api/cron/cleanup') return cleanup(req, res);
    if (route === 'POST /api/upload-url') return uploadUrl(req, res);
    if (route === 'POST /api/links') return createLink(req, res);
    const room = url.pathname.match(/^\/api\/rooms\/([^/]+)(\/.*)?$/);
    if (room) return roomApi(req, res, url, room);

    // Owner only from here on.
    if (!ownerAvailable) return send(res, 404, { code: 'not_found', error: 'Not found' });
    if (!owner(req)) return send(res, 401, { code: 'unauthorized', error: 'Authentication required' });
    if (route === 'GET /api/me') return send(res, 200, { owner: true });
    if (route === 'POST /api/send') return sendShare(req, res);
    if (route === 'GET /api/history') {
      const base = baseOf(req);
      return send(res, 200, { shares: (await shares.recent(20, 'sms')).map((s) => publicShare(s, base)) });
    }
    const status = url.pathname.match(/^\/api\/shares\/([A-Za-z0-9]{10})\/status$/);
    if (status && req.method === 'GET') return refreshStatus(req, res, status[1]);
    return send(res, 404, { code: 'not_found', error: 'Not found' });
  }

  function serveStatic(req, res, url) {
    if (!publicDir) return send(res, 404, 'Not found', 'text/plain');
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
    if (rel === '/') rel = '/index.html';
    if (!path.extname(rel)) rel += '.html'; // clean URLs, like Vercel's cleanUrls: /phone → phone.html
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
    });
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      // The share page's Download buttons send Origin: null (the page hides its referrer); a download
      // changes nothing, so it is the one POST that needn't come from this site.
      const shareDownload = req.method === 'POST' && /^\/s\/[^/]+\/file\/\d+\/?$/.test(url.pathname);
      if (req.method !== 'GET' && req.method !== 'HEAD' && !shareDownload && !sameOrigin(req)) {
        return send(res, 403, { code: 'forbidden', error: 'Cross-site request refused.' });
      }
      if (files.handle && await files.handle(req, res, url)) return;
      if (url.pathname.startsWith('/s/')) {
        if (misconfigured) return send(res, 503, 'MMBASAP isn’t set up yet.', 'text/plain; charset=utf-8');
        return await sharePublic(req, res, url);
      }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return serveStatic(req, res, url);
    } catch (err) {
      if (err instanceof ApiError) return send(res, err.status, err.body);
      if (err instanceof AuthError) return send(res, err.status, { code: 'unauthorized', error: err.message });
      log.error?.(err);
      return send(res, 500, { code: 'server_error', error: 'Something went wrong on the server.' });
    }
  };
}
