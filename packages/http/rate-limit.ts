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
   * Requests that are never counted, decided by the caller: the operator's own calls that carry the
   * admin token, for example. Nothing is exempt by default, a request from this machine included: a
   * proxy on the same machine that adds no forwarding header looks exactly like one.
   */
  exempt?: (request: IncomingMessage) => boolean;
  /** No longer has an effect: requests from this machine are always counted. Kept so callers still compile. */
  countLocal?: boolean;
};

const isLoopback = (address: string) =>
  address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');

/**
 * Addresses that are never a visitor of a public site: this machine, private networks (RFC 1918,
 * the Docker bridge among them), carrier-grade NAT, link-local, and the IPv6 unique-local range.
 * A request that is counted under such a socket address may be every visitor behind one proxy.
 */
function isPrivate(value: string) {
  if (isLoopback(value)) return true;
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return /^f[cd]/.test(value) || /^fe[89ab]/.test(value);
}

/** The eight groups of an IPv6 address, without leading zeroes. */
function ipv6Groups(value: string) {
  const [head, tail] = value.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return groups.map(group => group.replace(/^0+(?=.)/, ''));
}

/**
 * An address as a counting key, or undefined when the text is not an IP address (optionally with a
 * port). An IPv6 address is counted by its /64 network, the block one subscriber is given: counted
 * one by one, a single visitor would have 2^64 separate allowances.
 */
function address(text: string | undefined) {
  if (!text) return undefined;
  let value = text.trim().toLowerCase();
  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) value = bracketed[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(':'));
  value = value.replace(/%.*$/, '');
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) value = value.slice(7);
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return undefined;
  // The loopback address stays as it is; an address with an embedded IPv4 part is rare enough to count whole.
  if (value === '::1' || value.includes('.')) return value;
  return `${ipv6Groups(value).slice(0, 4).join(':')}::/64`;
}

/** Every value of a header, split on commas, in the order the proxies wrote them. */
function headerValues(request: IncomingMessage, name: string) {
  const raw = request.headers[name];
  return (Array.isArray(raw) ? raw : [raw ?? ''])
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean);
}

/** Who a request is counted as. */
export type ClientIdentity = {
  /** The counting key: an IPv4 address, an IPv6 /64 network, or the raw socket address. */
  key: string;
  /**
   * True when the key is a socket address that cannot be a visitor of a public site (this machine or
   * a private network), or the address of a proxy whose configured header was missing. Such a key
   * may stand for every visitor at once, so nothing may lock it the way one client is locked.
   */
  shared: boolean;
};

/**
 * Who a request is counted as. Every request is counted; none is exempt for where it comes from.
 *
 * A client can put anything in a header, so a header is believed only when configuration says
 * which proxy writes it:
 *
 * - `auto` (default; `apps/server` refuses it in production): a peer that is not this machine is
 *   counted by its socket address and its headers are ignored. A loopback peer may be a tunnel or
 *   proxy on this machine, so the last `X-Forwarded-For` entry (the address that proxy saw) is
 *   used when there is one. `CF-Connecting-IP` is not believed here: only Cloudflare overwrites it,
 *   and a local proxy that is not Cloudflare would pass along whatever the client sent.
 * - `none`: the socket address, always. Behind any proxy all visitors share one allowance.
 * - `x-forwarded-for` with `trustedHops` N: there are N proxies you control in front (the peer is
 *   the nearest). The entry N from the end of `X-Forwarded-For` is the address the outermost of
 *   them saw; entries further left were written by the client.
 * - `header` with a name such as `cf-connecting-ip`: your proxy overwrites that single-value
 *   header on every request. Use it only when clients cannot reach the server around the proxy.
 *
 * When the configured header is missing or does not hold an IP address the socket address is
 * used, so a broken proxy setup narrows to one shared allowance instead of opening a bypass, and
 * the identity says `shared` so that callers do not lock every visitor out together.
 */
export function clientIdentityOf(request: IncomingMessage, source: ClientAddressSource): ClientIdentity {
  const peer = request.socket.remoteAddress ?? 'unknown';
  const peerKey = address(peer) ?? peer;
  const forwardedFor = headerValues(request, 'x-forwarded-for');
  let stated: string | undefined;
  if (source.kind === 'auto') stated = isLoopback(peer) ? address(forwardedFor.at(-1)) : undefined;
  else if (source.kind === 'x-forwarded-for') stated = address(forwardedFor.at(-source.trustedHops));
  else if (source.kind === 'header') {
    const values = headerValues(request, source.name);
    stated = values.length === 1 ? address(values[0]) : undefined;
  }
  if (stated) return { key: stated, shared: false };
  // No believable header. With a header configured the peer is the proxy; otherwise a peer on this
  // machine or on a private network may be one.
  const expectsProxy = source.kind === 'x-forwarded-for' || source.kind === 'header';
  return { key: peerKey, shared: expectsProxy || isPrivate(peerKey) };
}

/** The address a request is counted under. See `clientIdentityOf`. */
export function clientAddressOf(request: IncomingMessage, source: ClientAddressSource, _countLocal?: boolean) {
  return clientIdentityOf(request, source).key;
}

/**
 * A fixed-window request counter per client address, with a ceiling for all clients together,
 * kept in memory. Enough to stop one client (or one client behind many addresses) from saturating
 * a single-process server; not a distributed limiter.
 */
export function createRateLimiter(options: RateLimitOptions) {
  const { limit, windowMs, now = Date.now } = options;
  const configured = options.clientAddress ?? clientAddressConfig();
  const source: ClientAddressSource =
    options.clientAddress === undefined && configured.kind === 'auto' && options.trustProxy
      ? { kind: 'x-forwarded-for', trustedHops: 1 }
      : configured;
  const globalLimit = options.globalLimit === undefined ? limit * 20 : options.globalLimit;
  const windows = new Map<string, { start: number; count: number }>();
  let everyone = { start: 0, count: 0 };
  /** Requests counted so far, and how many of them under a key that may be every visitor at once. */
  const counted = { total: 0, shared: 0 };

  const clientIdentity = (request: IncomingMessage) => clientIdentityOf(request, source);
  const clientKey = (request: IncomingMessage) => clientIdentity(request).key;
  const secondsLeft = (window: { start: number }, time: number) => Math.ceil((window.start + windowMs - time) / 1000);

  /**
   * Counts the request and returns whether it may proceed, plus seconds until it may be tried
   * again. A request refused for its own client's limit does not use up the shared ceiling.
   */
  function check(request: IncomingMessage) {
    if (options.exempt?.(request)) return { allowed: true, retryAfterSeconds: 0 };
    const { key, shared } = clientIdentity(request);
    counted.total++;
    if (shared) counted.shared++;
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

  return {
    check,
    clientKey,
    clientIdentity,
    /** The address source in use, after the environment and the older switch were applied. */
    source,
    /** Requests counted since the start, and how many of them could not be told apart from other visitors. */
    counted: () => ({ ...counted }),
  };
}
