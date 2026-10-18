// Small in-memory rate limiter for public routes: at most `max` hits per key
// in a sliding `windowMs`. Per instance, so on Vercel it is a speed bump; the
// Vercel Firewall rate-limit rule and the daily upload budget are the fences.

export function createRateLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  return {
    /** Records a hit; false when the key is over its limit. */
    take(key) {
      const t = now();
      const recent = (hits.get(key) || []).filter((at) => t - at < windowMs);
      if (recent.length >= max) { hits.set(key, recent); return false; }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 10_000) hits.clear(); // bound memory under abuse
      return true;
    },
  };
}
