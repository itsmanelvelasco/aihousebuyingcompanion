import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { ClientAddressSource } from '../config/env.ts';
import { clientAddressConfig } from '../config/env.ts';

export type { ClientAddressSource } from '../config/env.ts';

export type RateLimitOptions = {
  /** Requests allowed per window for one client. */
  limit: number;
  windowMs: number;
  now?: () => number;
  /**
   * Requests allowed per window for all counted clients together, so that a caller who rotates
   * addresses still meets a ceiling. Default: twenty times `limit`. Null removes the ceiling.
   */
  globalLimit?: number | null;
  /**
   * Which header, if any, states the client's address. Default: `CLIENT_IP_HEADER` and
   * `TRUSTED_PROXY_HOPS` from the environment (see `clientAddressConfig`), which is `auto` when
   * they are unset.
   */
  clientAddress?: ClientAddressSource;
  /**
   * Older switch, kept for callers that pass `TRUST_PROXY=on`: the same as
   * `clientAddress: { kind: 'x-forwarded-for', trustedHops: 1 }`. Ignored when `clientAddress`
   * is given or configured in the environment.
   */
  trustProxy?: boolean;
  /**
   * Count requests this machine makes to itself too. By default a loopback request without any
   * forwarding header is the server calling itself and is exempt.
   */
  countLocal?: boolean;
};

/** Headers a tunnel or reverse proxy adds. Their presence means the request did not start on this machine. */
const forwardingHeaders = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
];

const isLoopback = (address: string) =>
  address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');

/** An address as a counting key, or undefined when the text is not an IP address (optionally with a port). */
function address(text: string | undefined) {
  if (!text) return undefined;
  let value = text.trim().toLowerCase();
  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) value = bracketed[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(':'));
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) value = value.slice(7);
  return isIP(value) ? value : undefined;
}

/** Every value of a header, split on commas, in the order the proxies wrote them. */
function headerValues(request: IncomingMessage, name: string) {
  const raw = request.headers[name];
  return (Array.isArray(raw) ? raw : [raw ?? ''])
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean);
}

/**
 * The address a request is counted under, or null when it is not counted at all.
 *
 * A client can put anything in a header, so a header is believed only when configuration says
 * which proxy writes it:
 *
 * - `auto` (default): a peer that is not this machine is counted by its socket address and its
 *   headers are ignored. A loopback peer is a tunnel or proxy on this machine, so the last
 *   `X-Forwarded-For` entry (the address that proxy saw) is used. `CF-Connecting-IP` is not
 *   believed here: only Cloudflare overwrites it, and a local proxy that is not Cloudflare would
 *   pass along whatever the client sent.
 * - `none`: the socket address, always. Behind any proxy all visitors share one allowance.
 * - `x-forwarded-for` with `trustedHops` N: there are N proxies you control in front (the peer is
 *   the nearest). The entry N from the end of `X-Forwarded-For` is the address the outermost of
 *   them saw; entries further left were written by the client.
 * - `header` with a name such as `cf-connecting-ip`: your proxy overwrites that single-value
 *   header on every request. Use it only when clients cannot reach the server around the proxy.
 *
 * When the configured header is missing or does not hold an IP address the socket address is
 * used, so a broken proxy setup narrows to one shared allowance instead of opening a bypass.
 */
export function clientAddressOf(request: IncomingMessage, source: ClientAddressSource, countLocal = false) {
  const peer = request.socket.remoteAddress ?? 'unknown';
  const peerKey = address(peer) ?? peer;
  const local = isLoopback(peer);
  const forwardedFor = headerValues(request, 'x-forwarded-for');
  let stated: string | undefined;
  if (source.kind === 'auto') stated = local ? address(forwardedFor.at(-1)) : undefined;
  else if (source.kind === 'x-forwarded-for') stated = address(forwardedFor.at(-source.trustedHops));
  else if (source.kind === 'header') {
    const values = headerValues(request, source.name);
    stated = values.length === 1 ? address(values[0]) : undefined;
  }
  if (stated) return stated;
  // No believable header. A loopback request with no proxy header at all is the server calling itself.
  if (local && !countLocal && forwardingHeaders.every(name => request.headers[name] === undefined)) return null;
  return peerKey;
}

/**
 * A fixed-window request counter per client address, with a ceiling for all clients together,
 * kept in memory. Enough to stop one client (or one client behind many addresses) from saturating
 * a single-process server; not a distributed limiter.
 */
export function createRateLimiter(options: RateLimitOptions) {
  const { limit, windowMs, now = Date.now, countLocal = false } = options;
  const configured = options.clientAddress ?? clientAddressConfig();
  const source: ClientAddressSource =
    options.clientAddress === undefined && configured.kind === 'auto' && options.trustProxy
      ? { kind: 'x-forwarded-for', trustedHops: 1 }
      : configured;
  const globalLimit = options.globalLimit === undefined ? limit * 20 : options.globalLimit;
  const windows = new Map<string, { start: number; count: number }>();
  let everyone = { start: 0, count: 0 };

  const clientKey = (request: IncomingMessage) => clientAddressOf(request, source, countLocal);
  const secondsLeft = (window: { start: number }, time: number) => Math.ceil((window.start + windowMs - time) / 1000);

  /**
   * Counts the request and returns whether it may proceed, plus seconds until it may be tried
   * again. A request refused for its own client's limit does not use up the shared ceiling.
   */
  function check(request: IncomingMessage) {
    const key = clientKey(request);
    if (key === null) return { allowed: true, retryAfterSeconds: 0 };
    const time = now();
    const known = windows.get(key);
    const window = known && time - known.start < windowMs ? known : { start: time, count: 0 };
    if (window.count >= limit) return { allowed: false, retryAfterSeconds: secondsLeft(window, time) };
    if (globalLimit !== null) {
      if (everyone.count === 0 || time - everyone.start >= windowMs) everyone = { start: time, count: 0 };
      if (everyone.count >= globalLimit) return { allowed: false, retryAfterSeconds: secondsLeft(everyone, time) };
      everyone.count++;
    }
    window.count++;
    // Only a request that was let through is remembered, so refused callers cannot grow the map.
    windows.set(key, window);
    // Forget idle clients so the map cannot grow without bound.
    if (windows.size > 10_000) {
      for (const [other, value] of windows) if (time - value.start >= windowMs) windows.delete(other);
    }
    return { allowed: true, retryAfterSeconds: secondsLeft(window, time) };
  }

  return { check, clientKey };
}
