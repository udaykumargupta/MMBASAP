// Pair-your-phone helpers, shared by the laptop page, the phone page and the
// tests. A pairing is { roomId, key }: the room id names the mailbox on the
// server; the key (256-bit AES-GCM) never leaves the two browsers — it rides
// in the QR code's #fragment, which browsers don't send to servers.
// Uses only Web Crypto, so it runs in browsers and in Node.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Base62 id from the CSPRNG, without modulo bias. */
export function randomId(length) {
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < 248) out += ALPHABET[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export function toB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const ROOM_ID = /^[A-Za-z0-9]{16}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;

export const newPairing = () => ({ roomId: randomId(16), key: toB64url(crypto.getRandomValues(new Uint8Array(32))) });
export const validPairing = (p) => Boolean(p && ROOM_ID.test(p.roomId || '') && KEY.test(p.key || ''));

/** The link inside the QR code: https://host/phone#r=<room>&k=<key> */
export const pairUrl = (base, p) => `${base.replace(/\/+$/, '')}/phone#r=${p.roomId}&k=${p.key}`;

/** Reads a pairing from a URL fragment ('#r=…&k=…'), or null. */
export function parsePairFragment(hash) {
  const q = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const p = { roomId: q.get('r') || '', key: q.get('k') || '' };
  return validPairing(p) ? p : null;
}

const importKey = (key) => crypto.subtle.importKey('raw', fromB64url(key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/** What a message is bound to, so it can't be replayed under another id or room. */
export const messageAad = (roomId, id) => `mmbasap:v1:${roomId}:${id}`;

/** Encrypts a JSON value → { iv, data } (both base64url). aad binds it to its room and id. */
export async function sealJson(key, value, aad = '') {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await importKey(key), enc.encode(JSON.stringify(value)));
  return { iv: toB64url(iv), data: toB64url(new Uint8Array(data)) };
}

/** Decrypts { iv, data } back to the JSON value; throws if the key, the aad or any byte is wrong. */
export async function openJson(key, { iv, data }, aad = '') {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv), additionalData: enc.encode(aad) }, await importKey(key), fromB64url(data));
  return JSON.parse(dec.decode(plain));
}

const digits = (e164) => String(e164 || '').replace(/\D/g, '');

/** Opens WhatsApp with this number and text filled in (official click-to-chat). */
export const whatsappLink = (e164, text) => `https://wa.me/${digits(e164)}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

/**
 * Opens the phone's Messages app with number and text filled in. iPhones read
 * the body after '&', Android after '?'.
 */
export function smsLink(e164, text, { ios = false } = {}) {
  const to = `+${digits(e164)}`;
  if (!text) return `sms:${to}`;
  return `sms:${to}${ios ? '&' : '?'}body=${encodeURIComponent(text)}`;
}

/**
 * The text the phone pre-fills. Files that can't be handed over directly
 * (always for SMS) go as the download link on its own last line.
 */
export function outgoingText({ text = '', link = '' }, { includeLink }) {
  const parts = [String(text).trim()];
  if (includeLink && link) parts.push(link);
  return parts.filter(Boolean).join('\n');
}
