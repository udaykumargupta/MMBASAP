// HTTP request handler, shared by the local server (local-server.js) and the
// Vercel function (api/index.js).
//
// Public:
//   GET  /api/public/config      → { authRequired, setupMissing, channels, limits, baseUrl }
//   POST /api/login              → { passcode } in, { token } out
//   GET  /s/:id                  → the share page the recipient opens from the SMS
//   POST /s/:id/file/:n          → 303 to a short-lived download URL
//   GET  /api/cron/cleanup       → deletes expired shares and their files (Vercel cron, CRON_SECRET)
// Signed in ("Authorization: Bearer <token>" once a passcode is set):
//   GET  /api/me
//   POST /api/upload-url         → { name, type, size } in, { fileId, upload: { url, method, headers } } out
//   POST /api/send               → { channel, to, text, files, expiresInDays } in, { share } out
//   GET  /api/shares/:id/status  → { share } with fresh delivery status
//   GET  /api/history            → { shares } newest first
// Errors are { code, error: <human text> }.
import fs from 'node:fs';
import path from 'node:path';
import { AuthError, passcodeMatches, createLoginLimiter } from './auth.js';
import { ChannelError } from './channels/index.js';
import { isFileId, MAX_FILE_BYTES, MAX_FILES } from './files.js';
import { randomId, SHARE_ID } from './ids.js';
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
    return JSON.parse(raw) ?? {};
  } catch {
    throw new ApiError(400, 'bad_request', 'Malformed JSON');
  }
}

/** Midnight in India, as an ISO time — the daily SMS limit resets then. */
export function startOfDayIST(now) {
  const t = now.getTime() + IST_OFFSET_MS;
  return new Date(t - (t % DAY_MS) - IST_OFFSET_MS).toISOString();
}

/** What the browser may see of a share (no internal file ids). */
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

/**
 * auth:     { passcode, sessions } — no passcode means single-user local mode
 * shares:   lib/shares.js     files: lib/files.js     channels: lib/channels/index.js
 * requireAuth:  refuse to work unless a passcode is configured (deployments)
 * setupMissing: settings a deployment still needs (shown on the sign-in page)
 * baseUrl:  PUBLIC_BASE_URL for share links; otherwise taken from the request
 * dailyLimit: SMS per day (India time) — protects the phone's SMS pack
 * cronSecret: Vercel sends "Authorization: Bearer <CRON_SECRET>" to cron routes
 */
export function createHandler({
  publicDir = null, auth = {}, shares, files, channels, requireAuth = false, setupMissing = [],
  baseUrl = '', dailyLimit = 50, cronSecret = '', log = console, now = () => new Date(),
  limiter = createLoginLimiter(),
}) {
  const authEnabled = Boolean(auth.passcode && auth.sessions);
  const misconfigured = setupMissing.length > 0 || (requireAuth && !authEnabled);

  const baseOf = (req) => {
    if (baseUrl) return baseUrl.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
    return `${proto}://${req.headers.host}`;
  };
  const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

  /** The signed-in caller, or null. Without a passcode (local mode) everyone is the owner. */
  function caller(req) {
    if (!authEnabled) return { local: true, sub: 'owner' };
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

  async function login(req, res) {
    if (!authEnabled) return send(res, 400, { code: 'bad_request', error: 'This server has no passcode set — you’re already in.' });
    const ip = clientIp(req);
    if (limiter.blocked(ip)) return send(res, 429, { code: 'too_many_attempts', error: 'Too many wrong passcodes. Wait 15 minutes and try again.' });
    const { passcode } = await readJson(req);
    if (!passcodeMatches(passcode, auth.passcode)) {
      limiter.fail(ip);
      log.warn?.(`[auth] wrong passcode from ${ip}`);
      return send(res, 401, { code: 'wrong_passcode', error: 'That passcode isn’t right.' });
    }
    limiter.reset(ip);
    return send(res, 200, { token: auth.sessions.issue({ sub: 'owner', name: 'Owner' }) });
  }

  async function uploadUrl(req, res) {
    const { name, type, size } = await readJson(req);
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new ApiError(400, 'bad_request', 'The file needs a name.');
    if (!(Number.isInteger(size) && size > 0)) throw new ApiError(400, 'bad_request', 'That file is empty.');
    if (size > MAX_FILE_BYTES) throw new ApiError(413, 'too_large', `Files can be up to ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
    const mime = typeof type === 'string' && type.length <= 100 ? type : '';
    const fileId = files.newFileId(name);
    return send(res, 200, { fileId, upload: await files.uploadTarget({ fileId, type: mime, size }) });
  }

  async function validFiles(list) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw new ApiError(400, 'bad_request', 'files must be a list.');
    if (list.length > MAX_FILES) throw new ApiError(400, 'too_many_files', `You can attach up to ${MAX_FILES} files.`);
    const out = [];
    for (const f of list) {
      if (!f || !isFileId(f.id)) throw new ApiError(400, 'bad_request', 'Unknown file.');
      if (!(await files.exists(f.id))) throw new ApiError(400, 'upload_missing', `“${String(f.name || 'A file')}” didn’t finish uploading. Attach it again.`);
      out.push({
        id: f.id,
        name: String(f.name || f.id.split('/').pop()).slice(0, 200),
        type: typeof f.type === 'string' ? f.type.slice(0, 100) : '',
        size: Number.isInteger(f.size) && f.size >= 0 ? f.size : 0,
      });
    }
    return out;
  }

  async function sendShare(req, res) {
    const body = await readJson(req);
    const channel = channels.get(body.channel || 'sms');
    if (!channel) throw new ApiError(400, 'channel_unavailable', 'That delivery channel isn’t available yet.');
    const phone = normalizePhone(body.to);
    if (!phone.ok) throw new ApiError(400, 'bad_number', phone.error);
    const text = cleanText(body.text);
    if (text.length > MAX_TEXT) throw new ApiError(400, 'too_long', `Text can be up to ${MAX_TEXT.toLocaleString('en-IN')} characters.`);
    const attached = await validFiles(body.files);
    if (!text && !attached.length) throw new ApiError(400, 'empty', 'Write something or attach a file first.');

    const at = now();
    const sentToday = await shares.countSince(startOfDayIST(at));
    if (sentToday >= dailyLimit) throw new ApiError(429, 'daily_limit', `You’ve sent ${dailyLimit} messages today — the limit resets at midnight.`);

    const days = EXPIRY_DAYS.includes(body.expiresInDays) ? body.expiresInDays : 7;
    const id = randomId(10);
    const base = baseOf(req);
    const sms = composeSms({ text, files: attached, link: `${base}/s/${id}` });
    let share = await shares.create({
      id,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + days * DAY_MS).toISOString(),
      channel: channel.id,
      to: phone.e164,
      text,
      files: attached,
      body: sms.body,
      mode: sms.mode,
      status: 'sending',
    });
    try {
      const result = await channel.send({ to: phone.e164, text: sms.body, idempotencyKey: id });
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
    if (!share) throw new ApiError(404, 'not_found', 'No such message.');
    const channel = channels.get(share.channel);
    if (channel && share.providerMessageId && !FINAL.has(share.status)) {
      try {
        const fresh = await channel.status(share.providerMessageId);
        if (fresh.status !== share.status) share = await shares.update(id, { status: fresh.status, error: fresh.error || null });
      } catch (err) {
        if (!(err instanceof ChannelError)) throw err;
        return send(res, 200, { share: publicShare(share, baseOf(req)), checkError: err.message });
      }
    }
    return send(res, 200, { share: publicShare(share, baseOf(req)) });
  }

  async function cleanup(req, res) {
    const header = String(req.headers.authorization || '');
    const viaCron = cronSecret && header === `Bearer ${cronSecret}`;
    if (!viaCron && !caller(req)) return send(res, 401, { code: 'unauthorized', error: 'Authentication required' });
    const old = await shares.expired(now().toISOString());
    for (const share of old) {
      await files.remove((share.files || []).map((f) => f.id));
      await shares.remove(share.id);
    }
    if (old.length) log.log?.(`[cleanup] removed ${old.length} expired share(s)`);
    return send(res, 200, { removed: old.length });
  }

  async function sharePublic(req, res, url) {
    const m = url.pathname.match(/^\/s\/([^/]+)(?:\/file\/(\d+))?\/?$/);
    if (!m) return send(res, 404, 'Not found', 'text/plain');
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
    const target = await files.downloadUrl(file.id, { type: file.type, name: file.name });
    res.writeHead(303, { Location: target, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return res.end();
  }

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/public/config') {
      return send(res, 200, {
        authRequired: authEnabled || requireAuth,
        setupMissing,
        channels: channels.list(),
        limits: { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxText: MAX_TEXT, dailyLimit, expiryDays: EXPIRY_DAYS },
        baseUrl: baseOf(req),
        storage: { shares: shares.kind, files: files.kind },
      });
    }
    if (misconfigured) {
      return send(res, 503, { code: 'not_configured', error: `This deployment isn’t set up yet. Missing: ${setupMissing.join(', ') || 'APP_PASSCODE'}.` });
    }
    if (route === 'POST /api/login') return login(req, res);
    if (route === 'GET /api/cron/cleanup') return cleanup(req, res);

    if (!caller(req)) return send(res, 401, { code: 'unauthorized', error: 'Authentication required' });

    if (route === 'GET /api/me') return send(res, 200, { owner: true });
    if (route === 'POST /api/upload-url') return uploadUrl(req, res);
    if (route === 'POST /api/send') return sendShare(req, res);
    if (route === 'GET /api/history') {
      const base = baseOf(req);
      return send(res, 200, { shares: (await shares.recent(20)).map((s) => publicShare(s, base)) });
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
      if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
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
