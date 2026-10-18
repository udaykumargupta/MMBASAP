import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createVercelHandler, ownerSetupMissing } from '../api/index.js';

async function serve(env) {
  const server = http.createServer(createVercelHandler(env));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  test.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
}

const STORAGE = { DATABASE_URL: 'postgres://x', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' };
const OWNER = { APP_PASSCODE: 'open-sesame', JWT_SECRET: 's'.repeat(40), SMSGATE_USER: 'u', SMSGATE_PASS: 'p' };

test('an empty deployment needs only the database and Blob store, and serves nothing until then', async () => {
  const call = await serve({});
  const cfg = await call('GET', '/api/public/config');
  assert.equal(cfg.status, 200);
  assert.deepEqual(cfg.json.setupMissing, ['DATABASE_URL (connect a Neon database)', 'BLOB_READ_WRITE_TOKEN (connect a private Blob store)']);
  assert.equal(cfg.json.owner.available, false);
  assert.equal((await call('GET', '/api/rooms/AAAAAAAAAAAAAAAA')).status, 503);
  assert.equal((await call('POST', '/api/login', { passcode: 'x' })).status, 503);
});

test('storage alone: pair-your-phone works for everyone, Auto SMS stays off', async () => {
  const call = await serve({ ...STORAGE });
  const cfg = await call('GET', '/api/public/config');
  assert.deepEqual(cfg.json.setupMissing, []);
  assert.equal(cfg.json.owner.available, false);
  assert.deepEqual(cfg.json.channels.filter((c) => c.enabled).map((c) => c.id), ['whatsapp', 'sms']);
  assert.equal((await call('POST', '/api/send', { to: '9876543210', text: 'hi' })).status, 404);
});

test('POSTGRES_URL is accepted as the database', async () => {
  const call = await serve({ POSTGRES_URL: 'postgres://x', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' });
  assert.deepEqual((await call('GET', '/api/public/config')).json.setupMissing, []);
});

test('Auto SMS switches on only with passcode, secret and gateway login, and then needs a session', async () => {
  assert.deepEqual(ownerSetupMissing({}), ['APP_PASSCODE (6+ characters)', 'JWT_SECRET (32+ characters)', 'SMSGATE_USER', 'SMSGATE_PASS']);
  assert.deepEqual(ownerSetupMissing({ ...OWNER, APP_PASSCODE: '123' }), ['APP_PASSCODE (6+ characters)']);
  assert.deepEqual(ownerSetupMissing({ APP_PASSCODE: 'open-sesame', JWT_SECRET: 's'.repeat(40), SMS_PROVIDER: 'console' }), []);

  const call = await serve({ ...STORAGE, ...OWNER });
  const cfg = await call('GET', '/api/public/config');
  assert.deepEqual(cfg.json.owner, { available: true, signInRequired: true, provider: 'sms-gate' });
  assert.equal((await call('GET', '/api/history')).status, 401);
  assert.equal((await call('POST', '/api/login', { passcode: 'wrong!' })).status, 401);
});
