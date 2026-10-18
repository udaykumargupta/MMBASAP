// Dry-run SMS: prints the message instead of sending it. Used for local
// development (SMS_PROVIDER=console) and tests. Messages "deliver" on the
// first status check so the UI's Queued → Sent → Delivered flow can be seen.

export function consoleSms({ log = console } = {}) {
  const sent = [];
  const states = new Map();
  return {
    id: 'sms',
    provider: 'console',
    sent,
    async send({ to, text, idempotencyKey }) {
      sent.push({ to, text, idempotencyKey });
      states.set(idempotencyKey, 'sent');
      log.log?.(`[sms:dry-run] to ${to}\n${text}\n`);
      return { status: 'sent', providerMessageId: idempotencyKey };
    },
    async status(providerMessageId) {
      if (!states.has(providerMessageId)) return { status: 'failed', error: 'Unknown message' };
      states.set(providerMessageId, 'delivered');
      return { status: 'delivered' };
    },
  };
}
