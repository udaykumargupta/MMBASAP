// Delivery channels. Every channel has the same shape, so WhatsApp and Gmail
// can be added later without touching the routes:
//   { id, label, enabled, note?, send({ to, text, idempotencyKey }) → { status, providerMessageId },
//     status(providerMessageId) → { status, error? } }
// status is 'queued' | 'sent' | 'delivered' | 'failed'.
import { smsGate } from './sms-gate.js';
import { consoleSms } from './console.js';

export { ChannelError } from './sms-gate.js';

/** Settings a real SMS channel needs, or [] when everything is there. */
export function smsSetupMissing(env) {
  const get = (k) => String(env[k] ?? '').trim();
  if (get('SMS_PROVIDER') === 'console') return [];
  return ['SMSGATE_USER', 'SMSGATE_PASS'].filter((k) => !get(k));
}

/** Picks the SMS sender from the environment: the phone gateway, or the dry run when SMS_PROVIDER=console. */
export function smsFromEnv(env, { fetch, log } = {}) {
  const get = (k) => String(env[k] ?? '').trim();
  if (get('SMS_PROVIDER') === 'console' || !get('SMSGATE_USER')) return consoleSms({ log });
  return smsGate({
    user: get('SMSGATE_USER'),
    pass: get('SMSGATE_PASS'),
    deviceId: get('SMSGATE_DEVICE_ID'),
    simNumber: Number(get('SMSGATE_SIM')) || 0,
    baseUrl: get('SMSGATE_URL') || undefined,
    fetch,
  });
}

/** The channel list the UI shows. Only SMS works in v1. */
export function createChannels({ sms }) {
  const all = [
    { id: 'sms', label: 'SMS', enabled: true, provider: sms.provider, send: sms.send, status: sms.status },
    { id: 'whatsapp', label: 'WhatsApp', enabled: false, note: 'Soon' },
    { id: 'email', label: 'Gmail', enabled: false, note: 'Soon' },
  ];
  return {
    list: () => all.map(({ id, label, enabled, note, provider }) => ({ id, label, enabled, note, provider })),
    get: (id) => all.find((c) => c.id === id && c.enabled) || null,
  };
}
