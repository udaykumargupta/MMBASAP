// Passcode sign-in. Work laptops often block personal Google sign-in, so the
// owner proves who they are with APP_PASSCODE and gets back our own HMAC-signed
// session token (sent as a Bearer header). Session tokens are the same HS256
// JWTs GiveMeBucks uses. Zero dependencies — only node:crypto.
import crypto from 'node:crypto';

export const MIN_SECRET_LENGTH = 32;
export const MIN_PASSCODE_LENGTH = 6;
/** Default session length (JWT_EXPIRATION_MS): 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

const fromB64url = (s) => Buffer.from(s, 'base64url');
const toB64url = (v) => Buffer.from(v).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();

/** Constant-time passcode check (hashing first makes the lengths equal). */
export function passcodeMatches(given, expected) {
  if (typeof given !== 'string' || !given || !expected) return false;
  return crypto.timingSafeEqual(sha256(given), sha256(expected));
}

/**
 * Slows down passcode guessing: after `max` failures from one address within
 * `windowMs`, further attempts are refused until the window passes. In memory,
 * so on Vercel it is per instance — the WAF rate-limit rule is the outer fence.
 */
export function createLoginLimiter({ max = 5, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const fails = new Map();
  const live = (key) => {
    const entry = fails.get(key);
    if (entry && now() - entry.first > windowMs) { fails.delete(key); return null; }
    return entry || null;
  };
  return {
    blocked: (key) => (live(key)?.count || 0) >= max,
    fail(key) {
      const entry = live(key) || { first: now(), count: 0 };
      entry.count++;
      fails.set(key, entry);
    },
    reset: (key) => fails.delete(key),
  };
}

/** Our own session tokens: HS256 JWTs with sub, name, iat, exp. */
export function createSessions({ secret, ttlMs = SESSION_TTL_MS, now = Date.now }) {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const key = Buffer.from(secret, 'utf8');
  const header = toB64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const sign = (input) => crypto.createHmac('sha256', key).update(input).digest();

  return {
    ttlMs,
    issue(user) {
      const iat = Math.floor(now() / 1000);
      const claims = { sub: user.sub, name: user.name || '', iat, exp: iat + Math.floor(ttlMs / 1000) };
      const input = `${header}.${toB64url(JSON.stringify(claims))}`;
      return `${input}.${toB64url(sign(input))}`;
    },
    /** Every failure collapses to null ("not signed in"). */
    verify(token) {
      if (typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      try {
        // Pin the algorithm so a token can't talk us into a weaker scheme.
        if (JSON.parse(fromB64url(parts[0])).alg !== 'HS256') return null;
        const got = fromB64url(parts[2]);
        const want = sign(`${parts[0]}.${parts[1]}`);
        if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
        const claims = JSON.parse(fromB64url(parts[1]));
        if (!(Number(claims.exp) * 1000 > now())) return null;
        if (typeof claims.sub !== 'string' || !claims.sub) return null;
        return { sub: claims.sub, name: claims.name || '', exp: claims.exp };
      } catch {
        return null;
      }
    },
  };
}
