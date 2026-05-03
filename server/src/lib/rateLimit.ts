// In-memory token-bucket rate limiter. Keyed by (bucket, userId or ip).
// Suitable for a single-instance deployment; if the server scales to
// multiple replicas, replace with Redis.
//
// Usage:
//   const rl = makeRateLimiter({ tokens: 10, windowMs: 60_000 });
//   if (!rl.consume(`chat:${userId}`)) { return tooMany(); }
//
// We deliberately keep this stateful in-process: rate-limit data is
// non-critical and tolerates restart resets.

interface Bucket {
  tokens: number;
  resetAt: number;
}

export interface RateLimiter {
  consume(key: string): boolean;
  remaining(key: string): number;
}

// Sweep policy. Two layers:
//   1. Opportunistic — when the map first crosses SWEEP_THRESHOLD, prune
//      every expired bucket on the next consume. Lower than before so
//      stale buckets don't pile up under high churn.
//   2. Background — a once-per-5-minute interval that prunes regardless,
//      so even idle buckets eventually drain. Marked .unref() so it
//      never holds the process open.
const SWEEP_THRESHOLD = 256;
const BACKGROUND_SWEEP_MS = 5 * 60_000;

export function makeRateLimiter(opts: { tokens: number; windowMs: number }): RateLimiter {
  const buckets = new Map<string, Bucket>();

  const sweep = () => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(k);
    }
  };

  // Background sweep — runs even when nothing is consuming, so buckets
  // for users who went offline don't sit around forever. .unref() so a
  // standalone test process doesn't hang waiting on this timer.
  const bgTimer = setInterval(sweep, BACKGROUND_SWEEP_MS);
  if (typeof bgTimer.unref === "function") bgTimer.unref();

  return {
    consume(key: string): boolean {
      const now = Date.now();
      const b = buckets.get(key);
      if (!b || b.resetAt <= now) {
        buckets.set(key, { tokens: opts.tokens - 1, resetAt: now + opts.windowMs });
        // Opportunistic sweep when the map crosses the threshold. Cheap
        // because Map iteration is fast and we expect most entries to
        // already be expired in steady state.
        if (buckets.size >= SWEEP_THRESHOLD) sweep();
        return true;
      }
      if (b.tokens <= 0) return false;
      b.tokens -= 1;
      return true;
    },
    remaining(key: string): number {
      const b = buckets.get(key);
      if (!b || b.resetAt <= Date.now()) return opts.tokens;
      return Math.max(0, b.tokens);
    },
  };
}
