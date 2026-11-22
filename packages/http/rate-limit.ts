import type { IncomingMessage } from 'node:http';

export type RateLimitOptions = {
  /** Requests allowed per window for one client. */
  limit: number;
  windowMs: number;
  now?: () => number;
  /** Believe `X-Forwarded-For` from any peer (set only behind a remote proxy you control). */
  trustProxy?: boolean;
};

const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * A fixed-window request counter per client address, kept in memory.
 * Enough to stop one client from saturating a single-process server; not a distributed limiter.
 */
export function createRateLimiter({ limit, windowMs, now = Date.now, trustProxy = false }: RateLimitOptions) {
  const windows = new Map<string, { start: number; count: number }>();

  /**
   * The address a request is counted under, or null when it is not counted at all.
   * A forwarded address is believed when the peer is a proxy or tunnel on this machine, or when
   * `trustProxy` is on. A loopback request with no forwarded address is the server calling
   * itself and is exempt.
   */
  function clientKey(request: IncomingMessage) {
    const peer = request.socket.remoteAddress ?? 'unknown';
    const local = loopback.has(peer);
    // The address the nearest proxy saw. Earlier X-Forwarded-For entries are supplied by the client
    // and cannot be believed; Cloudflare states the real one in its own header.
    const chain = String(request.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean);
    const forwarded = String(request.headers['cf-connecting-ip'] ?? '').trim() || chain.at(-1) || '';
    if (forwarded && (local || trustProxy)) return forwarded;
    return local ? null : peer;
  }

  /** Counts the request and returns whether it may proceed, plus seconds until the window resets. */
  function check(request: IncomingMessage) {
    const key = clientKey(request);
    if (key === null) return { allowed: true, retryAfterSeconds: 0 };
    const time = now();
    let window = windows.get(key);
    if (!window || time - window.start >= windowMs) {
      window = { start: time, count: 0 };
      windows.set(key, window);
    }
    window.count++;
    // Forget idle clients so the map cannot grow without bound.
    if (windows.size > 10_000) {
      for (const [other, value] of windows) if (time - value.start >= windowMs) windows.delete(other);
    }
    return { allowed: window.count <= limit, retryAfterSeconds: Math.ceil((window.start + windowMs - time) / 1000) };
  }

  return { check };
}
