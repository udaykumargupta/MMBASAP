// MMBASAP — local server. Serves the app and API (lib/app.js) on this Mac and
// keeps shares and files under ./data.
// Settings come from the environment or a .env file (see .env.example).
// With no SMSGATE_USER (or SMS_PROVIDER=console) SMS are printed here instead of sent.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createHandler, send } from './lib/app.js';
import { createSessions, MIN_PASSCODE_LENGTH, MIN_SECRET_LENGTH, SESSION_TTL_MS } from './lib/auth.js';
import { createChannels, smsFromEnv } from './lib/channels/index.js';
import { createFiles } from './lib/files.js';
import { createShares } from './lib/shares.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(ROOT, '.env');
if (typeof process.loadEnvFile === 'function' && fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const env = (key, fallback = '') => (process.env[key] ?? '').trim() || fallback;
const PUBLIC = path.join(ROOT, 'public');
const DATA = env('MMBASAP_DATA_DIR', path.join(ROOT, 'data'));
const PORT = Number(env('PORT')) || 4190;
const URL_BASE = `http://localhost:${PORT}`;
fs.mkdirSync(DATA, { recursive: true });

// ---------------------------------------------------------------- sign-in
const passcode = env('APP_PASSCODE');
const secret = env('JWT_SECRET');
const auth = {};
if (passcode) {
  if (passcode.length < MIN_PASSCODE_LENGTH || secret.length < MIN_SECRET_LENGTH) {
    console.error(`APP_PASSCODE needs ${MIN_PASSCODE_LENGTH}+ characters and JWT_SECRET ${MIN_SECRET_LENGTH}+ characters.`);
    console.error('Generate a secret with:  openssl rand -base64 48   and put it in .env as JWT_SECRET=...');
    process.exit(1);
  }
  Object.assign(auth, { passcode, sessions: createSessions({ secret, ttlMs: Number(env('JWT_EXPIRATION_MS')) || SESSION_TTL_MS }) });
}

// ------------------------------------------------------------------ parts
const shares = createShares({ env: process.env, dataDir: DATA });
// Local file links are signed with JWT_SECRET, or a fresh key each run when there is none.
const files = createFiles({ env: process.env, dataDir: DATA, secret: secret || crypto.randomBytes(32).toString('hex') });
const sms = smsFromEnv(process.env);
const handle = createHandler({
  publicDir: PUBLIC,
  auth,
  shares,
  files,
  channels: createChannels({ sms }),
  baseUrl: env('PUBLIC_BASE_URL'),
  dailyLimit: Number(env('DAILY_LIMIT')) || 50,
});

// Answer requests addressed to this machine only (blocks DNS-rebinding reads).
// LAN_HOST (e.g. 192.168.1.20) lets a phone on the same Wi-Fi open share links.
const lanHost = env('LAN_HOST');
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`, ...(lanHost ? [`${lanHost}:${PORT}`] : [])]);
const server = http.createServer((req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 421, 'Misdirected request', 'text/plain');
  return handle(req, res);
});

server.listen(PORT, lanHost ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`MMBASAP running at ${URL_BASE}`);
  console.log(`Sign-in: ${passcode ? 'passcode' : 'off (local mode — set APP_PASSCODE and JWT_SECRET in .env to require one)'}`);
  console.log(`SMS:     ${sms.provider === 'console' ? 'dry run — messages are printed here (set SMSGATE_USER/SMSGATE_PASS to send for real)' : 'your phone via SMS Gateway for Android'}`);
  console.log(`Data:    ${shares.kind === 'database' ? 'Neon Postgres (DATABASE_URL)' : shares.file}; files: ${files.kind === 'blob' ? 'Vercel Blob' : path.join(DATA, 'files')}`);
  if (process.argv.includes('--open')) execFile('/usr/bin/open', [URL_BASE], () => {});
});
