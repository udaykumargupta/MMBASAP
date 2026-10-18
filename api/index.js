// Vercel entry point. vercel.json rewrites /api/* and /s/* here; the files in
// public/ are served by Vercel's CDN. Same handler as the local server.
//
// Required: a Neon database and a private Blob store — until both are
// connected the deployment serves nothing but the setup list. Vercel connects
// Blob stores by OIDC (it sets BLOB_STORE_ID and sends a short-lived token with
// every request); a BLOB_READ_WRITE_TOKEN works too.
// Optional: the owner's automatic SMS. It switches on only when APP_PASSCODE,
// JWT_SECRET and the phone gateway login (SMSGATE_USER/SMSGATE_PASS) are all set.
import { createHandler } from '../lib/app.js';
import { createSessions, MIN_PASSCODE_LENGTH, MIN_SECRET_LENGTH, SESSION_TTL_MS } from '../lib/auth.js';
import { createChannels, smsConfigured, smsFromEnv } from '../lib/channels/index.js';
import { blobFiles } from '../lib/files.js';
import { neonRooms } from '../lib/rooms.js';
import { databaseUrl, neonShares } from '../lib/shares.js';

/** '' → the default; 0 is allowed (turns public files off). */
export function megabytes(raw, fallback) {
  const n = String(raw ?? '').trim() === '' ? fallback : Number(raw);
  return (Number.isFinite(n) && n >= 0 ? n : fallback) * 1024 * 1024;
}

/** What the owner's automatic SMS still needs ([] = on). */
export function ownerSetupMissing(env) {
  const get = (key) => String(env[key] ?? '').trim();
  const missing = [];
  if (get('APP_PASSCODE').length < MIN_PASSCODE_LENGTH) missing.push(`APP_PASSCODE (${MIN_PASSCODE_LENGTH}+ characters)`);
  if (get('JWT_SECRET').length < MIN_SECRET_LENGTH) missing.push(`JWT_SECRET (${MIN_SECRET_LENGTH}+ characters)`);
  if (!smsConfigured(env)) missing.push('SMSGATE_USER', 'SMSGATE_PASS');
  return missing;
}

export function createVercelHandler(env = process.env) {
  const get = (key) => String(env[key] ?? '').trim();
  const dbUrl = databaseUrl(env);
  const blobToken = get('BLOB_READ_WRITE_TOKEN');
  const blobStore = get('BLOB_STORE_ID');

  const setupMissing = [];
  if (!dbUrl) setupMissing.push('DATABASE_URL (connect a Neon database)');
  if (!blobToken && !blobStore) setupMissing.push('BLOB_STORE_ID (connect a private Blob store)');
  const ready = setupMissing.length === 0;
  const ownerOn = ready && ownerSetupMissing(env).length === 0;

  return createHandler({
    publicDir: null,
    requireAuth: true,
    setupMissing,
    auth: ownerOn ? { passcode: get('APP_PASSCODE'), sessions: createSessions({ secret: get('JWT_SECRET'), ttlMs: Number(get('JWT_EXPIRATION_MS')) || SESSION_TTL_MS }) } : {},
    shares: ready ? neonShares(dbUrl) : { kind: 'database' },
    rooms: ready ? neonRooms(dbUrl) : null,
    files: ready ? blobFiles({ token: blobToken || undefined }) : { kind: 'blob' },
    channels: createChannels({ sms: ownerOn ? smsFromEnv(env) : null }),
    baseUrl: get('PUBLIC_BASE_URL'),
    dailyLimit: Number(get('DAILY_LIMIT')) || 50,
    publicStorageBytes: megabytes(get('PUBLIC_STORAGE_MB'), 600),
    publicDailyDownloadBytes: megabytes(get('PUBLIC_DAILY_DOWNLOAD_MB'), 300),
    cronSecret: get('CRON_SECRET'),
    trustProxy: true, // Vercel's proxy sets X-Forwarded-For
  });
}

let handler;
export default function vercelHandler(req, res) {
  // Vercel sends its OIDC token with each request; the Blob SDK reads it from here.
  const oidc = req.headers['x-vercel-oidc-token'];
  if (typeof oidc === 'string' && oidc) process.env.VERCEL_OIDC_TOKEN = oidc;
  handler ||= createVercelHandler();
  return handler(req, res);
}
