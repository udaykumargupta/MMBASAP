// SMS through the owner's own Android phone, using the "SMS Gateway for
// Android" app (capcom6, https://sms-gate.app) in Cloud Server mode. The
// backend asks the public cloud server to send; the server wakes the phone,
// and the phone sends an ordinary SMS from its own SIM and number.
//
//   POST {base}/messages        { id, textMessage: { text }, phoneNumbers, ... } → 202 { id, state }
//   GET  {base}/messages/{id}   → { id, state, recipients: [{ phoneNumber, state, error }] }
// Auth: HTTP Basic with the username/password the app shows under Cloud Server.
// States: Pending → Processed → Sent → Delivered, or Failed.

export const SMSGATE_CLOUD = 'https://api.sms-gate.app/3rdparty/v1';

const STATE = { Pending: 'queued', Processed: 'queued', Sent: 'sent', Delivered: 'delivered', Failed: 'failed' };
const mapState = (s) => STATE[s] || 'queued';

export class ChannelError extends Error {
  /** code: phone_offline | gateway_auth | gateway_unreachable | gateway_error | bad_request */
  constructor(code, message, { status = 502, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function smsGate({ user, pass, deviceId = '', simNumber = 0, baseUrl = SMSGATE_CLOUD, ttlSeconds = 3600, fetch = globalThis.fetch }) {
  const auth = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const base = baseUrl.replace(/\/+$/, '');

  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ChannelError('gateway_unreachable', 'Couldn’t reach the SMS gateway. Try again in a moment.', { retryable: true });
    }
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  function fail(res, data) {
    const detail = typeof data?.message === 'string' ? data.message : '';
    if (res.status === 401 || res.status === 403) {
      return new ChannelError('gateway_auth', 'The SMS gateway rejected the login. Check SMSGATE_USER and SMSGATE_PASS against the app’s Cloud Server screen.');
    }
    if (res.status === 503 || res.status === 429) {
      return new ChannelError('phone_offline', 'Your phone isn’t taking messages right now. Make sure the SMS Gateway app is online and has internet.', { status: 503, retryable: true });
    }
    if (res.status === 400) return new ChannelError('bad_request', `The SMS gateway refused the message${detail ? `: ${detail}` : '.'}`, { status: 400 });
    return new ChannelError('gateway_error', `The SMS gateway returned an error (${res.status})${detail ? `: ${detail}` : ''}.`, { retryable: res.status >= 500 });
  }

  return {
    id: 'sms',
    provider: 'sms-gate',
    async send({ to, text, idempotencyKey }) {
      const payload = {
        id: idempotencyKey,
        textMessage: { text },
        phoneNumbers: [to],
        withDeliveryReport: true,
        priority: 100, // >= 100 skips the app's random anti-spam delay; we only send one at a time
        ttl: ttlSeconds,
      };
      if (deviceId) payload.deviceId = deviceId;
      if (simNumber) payload.simNumber = simNumber;
      const { res, data } = await call('POST', '/messages', payload);
      // 409: this id was already accepted (a retried request) — that's success.
      if (res.status === 409) return { status: 'queued', providerMessageId: idempotencyKey };
      if (!res.ok) throw fail(res, data);
      return { status: mapState(data.state), providerMessageId: data.id || idempotencyKey };
    },
    async status(providerMessageId) {
      const { res, data } = await call('GET', `/messages/${encodeURIComponent(providerMessageId)}`);
      if (!res.ok) throw fail(res, data);
      const recipient = Array.isArray(data.recipients) ? data.recipients[0] : null;
      const status = mapState(recipient?.state || data.state);
      return { status, error: status === 'failed' ? (recipient?.error || 'The phone couldn’t send this SMS.') : undefined };
    },
  };
}
