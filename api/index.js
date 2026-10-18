// Vercel entry point. vercel.json rewrites /api/* and /s/* here; the files in
// public/ are served by Vercel's CDN. Same handler as the local server, but a
// deployment fails closed: until the passcode, session secret, database, file
// store and SMS gateway are configured, it serves nothing but the setup list.
import { createHandler } from '../lib/app.js';
import { createSessions, MIN_PASSCODE_LENGTH, MIN_SECRET_LENGTH, SESSION_TTL_MS } from '../lib/auth.js';
import { createChannels, smsFromEnv, smsSetupMissing } from '../lib/channels/index.js';
import { blobFiles } from '../lib/files.js';
import { databaseUrl, neonShares } from '../lib/shares.js';

export function createVercelHandler(env = process.env) {
  const get = (key) => String(env[key] ?? '').trim();
  const passcode = get('APP_PASSCODE');
  const secret = get('JWT_SECRET');
  const dbUrl = databaseUrl(env);
  const blobToken = get('BLOB_READ_WRITE_TOKEN');

  const setupMissing = [];
  if (passcode.length < MIN_PASSCODE_LENGTH) setupMissing.push(`APP_PASSCODE (${MIN_PASSCODE_LENGTH}+ characters)`);
  if (secret.length < MIN_SECRET_LENGTH) setupMissing.push(`JWT_SECRET (${MIN_SECRET_LENGTH}+ characters)`);
  if (!dbUrl) setupMissing.push('DATABASE_URL (connect a Neon database)');
  if (!blobToken) setupMissing.push('BLOB_READ_WRITE_TOKEN (connect a private Blob store)');
  setupMissing.push(...smsSetupMissing(env));

  const ready = setupMissing.length === 0;
  return createHandler({
    publicDir: null,
    requireAuth: true,
    setupMissing,
    auth: ready ? { passcode, sessions: createSessions({ secret, ttlMs: Number(get('JWT_EXPIRATION_MS')) || SESSION_TTL_MS }) } : {},
    shares: ready ? neonShares(dbUrl) : { kind: 'database' },
    files: ready ? blobFiles({ token: blobToken }) : { kind: 'blob' },
    channels: createChannels({ sms: smsFromEnv(env) }),
    baseUrl: get('PUBLIC_BASE_URL'),
    dailyLimit: Number(get('DAILY_LIMIT')) || 50,
    cronSecret: get('CRON_SECRET'),
  });
}

let handler;
export default function vercelHandler(req, res) {
  handler ||= createVercelHandler();
  return handler(req, res);
}
