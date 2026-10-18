// Unguessable ids for share links and file paths: base62, from the OS CSPRNG.
// 10 characters ≈ 59 bits — far beyond guessing, short enough for one SMS.
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomId(length = 10) {
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte < 248) out += ALPHABET[byte % 62]; // 248 = 4 × 62: no modulo bias
      if (out.length === length) break;
    }
  }
  return out;
}

export const SHARE_ID = /^[A-Za-z0-9]{10}$/;
