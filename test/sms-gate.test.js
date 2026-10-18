import test from 'node:test';
import assert from 'node:assert/strict';
import { smsGate, ChannelError, SMSGATE_CLOUD } from '../lib/channels/sms-gate.js';

/** A fetch stub that records calls and answers from a script. */
function stubFetch(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const { status = 200, json = {} } = typeof reply === 'function' ? reply(url, init) : reply;
    return { status, ok: status >= 200 && status < 300, json: async () => json };
  };
  return { fetch, calls };
}

const gate = (fetch, extra = {}) => smsGate({ user: 'ABC', pass: 'secret', fetch, ...extra });

test('send posts one text message to the cloud API with Basic auth and our id', async () => {
  const { fetch, calls } = stubFetch({ status: 202, json: { id: 'share12345', state: 'Pending' } });
  const r = await gate(fetch, { deviceId: 'dev1', simNumber: 2 }).send({ to: '+919876543210', text: 'hi', idempotencyKey: 'share12345' });
  assert.deepEqual(r, { status: 'queued', providerMessageId: 'share12345' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${SMSGATE_CLOUD}/messages`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('ABC:secret').toString('base64')}`);
  assert.deepEqual(calls[0].body, {
    id: 'share12345', textMessage: { text: 'hi' }, phoneNumbers: ['+919876543210'],
    withDeliveryReport: true, priority: 100, ttl: 3600, deviceId: 'dev1', simNumber: 2,
  });
});

test('device and SIM are left out unless configured', async () => {
  const { fetch, calls } = stubFetch({ status: 202, json: { id: 'x', state: 'Pending' } });
  await gate(fetch).send({ to: '+919876543210', text: 'hi', idempotencyKey: 'x' });
  assert.equal('deviceId' in calls[0].body, false);
  assert.equal('simNumber' in calls[0].body, false);
});

test('a repeated id (409) counts as already accepted', async () => {
  const { fetch } = stubFetch({ status: 409, json: { message: 'exists' } });
  assert.deepEqual(await gate(fetch).send({ to: '+91', text: 't', idempotencyKey: 'dup' }), { status: 'queued', providerMessageId: 'dup' });
});

const failureCases = [
  [401, 'gateway_auth'],
  [403, 'gateway_auth'],
  [503, 'phone_offline'],
  [429, 'phone_offline'],
  [400, 'bad_request'],
  [500, 'gateway_error'],
];
for (const [status, code] of failureCases) {
  test(`HTTP ${status} becomes a ${code} error the UI can explain`, async () => {
    const { fetch } = stubFetch({ status, json: { message: 'nope' } });
    await assert.rejects(gate(fetch).send({ to: '+91', text: 't', idempotencyKey: 'k' }), (err) => {
      assert.ok(err instanceof ChannelError);
      assert.equal(err.code, code);
      assert.ok(err.message.length > 10);
      return true;
    });
  });
}

test('network failure is a retryable gateway_unreachable error', async () => {
  const fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(gate(fetch).send({ to: '+91', text: 't', idempotencyKey: 'k' }), (err) => err.code === 'gateway_unreachable' && err.retryable);
});

test('status maps the recipient state and reports why a send failed', async () => {
  const states = { a: 'Pending', b: 'Processed', c: 'Sent', d: 'Delivered' };
  const { fetch, calls } = stubFetch((url) => {
    const id = url.split('/').pop();
    if (id === 'e') return { json: { id, state: 'Failed', recipients: [{ phoneNumber: '+91', state: 'Failed', error: 'RESULT_ERROR_NO_SERVICE' }] } };
    return { json: { id, state: states[id], recipients: [{ phoneNumber: '+91', state: states[id] }] } };
  });
  const g = gate(fetch);
  assert.deepEqual(await g.status('a'), { status: 'queued', error: undefined });
  assert.deepEqual(await g.status('b'), { status: 'queued', error: undefined });
  assert.deepEqual(await g.status('c'), { status: 'sent', error: undefined });
  assert.deepEqual(await g.status('d'), { status: 'delivered', error: undefined });
  assert.deepEqual(await g.status('e'), { status: 'failed', error: 'RESULT_ERROR_NO_SERVICE' });
  assert.equal(calls[0].url, `${SMSGATE_CLOUD}/messages/a`);
  assert.equal(calls[0].init.method, 'GET');
});
