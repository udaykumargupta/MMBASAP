import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createVercelHandler } from '../api/index.js';

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

test('an empty deployment fails closed and says exactly what is missing', async () => {
  const call = await serve({});
  const cfg = await call('GET', '/api/public/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.json.authRequired, true);
  assert.deepEqual(cfg.json.setupMissing, [
    'APP_PASSCODE (6+ characters)',
    'JWT_SECRET (32+ characters)',
    'DATABASE_URL (connect a Neon database)',
    'BLOB_READ_WRITE_TOKEN (connect a private Blob store)',
    'SMSGATE_USER',
    'SMSGATE_PASS',
  ]);
  assert.equal((await call('POST', '/api/login', { passcode: 'x' })).status, 503);
  assert.equal((await call('POST', '/api/send', { to: '9876543210', text: 'hi' })).status, 503);
});

test('a short passcode or secret counts as missing; POSTGRES_URL is accepted; SMS_PROVIDER=console skips the gateway', async () => {
  const call = await serve({
    APP_PASSCODE: '123', JWT_SECRET: 'short', POSTGRES_URL: 'postgres://x', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x', SMS_PROVIDER: 'console',
  });
  const cfg = await call('GET', '/api/public/config');
  assert.deepEqual(cfg.json.setupMissing, ['APP_PASSCODE (6+ characters)', 'JWT_SECRET (32+ characters)']);
});

test('fully configured: nothing missing, and the API needs a session', async () => {
  const call = await serve({
    APP_PASSCODE: 'open-sesame', JWT_SECRET: 's'.repeat(40), DATABASE_URL: 'postgres://x',
    BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x', SMSGATE_USER: 'u', SMSGATE_PASS: 'p',
  });
  const cfg = await call('GET', '/api/public/config');
  assert.deepEqual(cfg.json.setupMissing, []);
  assert.equal(cfg.json.channels[0].provider, 'sms-gate');
  assert.equal((await call('GET', '/api/history')).status, 401);
  assert.equal((await call('POST', '/api/login', { passcode: 'wrong!' })).status, 401);
});
