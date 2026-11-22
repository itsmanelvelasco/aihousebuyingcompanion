import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
import { clientAddressConfig } from '../packages/config/env.ts';
import { createRateLimiter } from '../packages/http/rate-limit.ts';

const request = (address: string, forwarded?: string) =>
  ({
    headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
    socket: { remoteAddress: address },
  }) as unknown as IncomingMessage;

test('rate limiter counts per client and resets after the window', () => {
  let time = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => time });
  assert.equal(limiter.check(request('1.1.1.1')).allowed, true);
  assert.equal(limiter.check(request('1.1.1.1')).allowed, true);
  const blocked = limiter.check(request('1.1.1.1'));
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 1);
  assert.equal(limiter.check(request('2.2.2.2')).allowed, true, 'another client has its own window');
  time = 1000;
  assert.equal(limiter.check(request('1.1.1.1')).allowed, true);
});

test('loopback calls are exempt, and a local tunnel is counted by the address it forwards', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
  for (let i = 0; i < 5; i++) assert.equal(limiter.check(request('127.0.0.1')).allowed, true);
  assert.equal(limiter.check(request('127.0.0.1', '3.3.3.3')).allowed, true);
  assert.equal(limiter.check(request('127.0.0.1', '3.3.3.3')).allowed, false);
});

test('forwarded addresses are used only when the proxy is trusted', () => {
  const direct = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
  assert.equal(direct.check(request('9.9.9.9', '1.1.1.1')).allowed, true);
  assert.equal(direct.check(request('9.9.9.9', '2.2.2.2')).allowed, false, 'spoofed header is ignored');
  const proxied = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0, trustProxy: true });
  assert.equal(proxied.check(request('9.9.9.9', '1.1.1.1')).allowed, true);
  assert.equal(proxied.check(request('9.9.9.9', '2.2.2.2')).allowed, true);
});

const withHeaders = (address: string, headers: Record<string, string | string[]>) =>
  ({ headers, socket: { remoteAddress: address } }) as unknown as IncomingMessage;

test('a client-sent CF-Connecting-IP buys nothing unless that header is the configured one', () => {
  const options = { limit: 1, windowMs: 1000, now: () => 0 };
  // Behind a proxy on this machine that is not Cloudflare: the proxy appends to X-Forwarded-For and
  // passes the client's own CF-Connecting-IP through untouched.
  const local = createRateLimiter(options);
  const spoof = (fake: string) => withHeaders('127.0.0.1', { 'x-forwarded-for': '7.7.7.7', 'cf-connecting-ip': fake });
  assert.equal(local.check(spoof('1.1.1.1')).allowed, true);
  assert.equal(local.check(spoof('2.2.2.2')).allowed, false, 'the forged header does not open a new window');
  // The same behind a remote proxy trusted for X-Forwarded-For.
  const remote = createRateLimiter({ ...options, clientAddress: { kind: 'x-forwarded-for', trustedHops: 1 } });
  const far = (fake: string) => withHeaders('10.0.0.5', { 'x-forwarded-for': '7.7.7.7', 'cf-connecting-ip': fake });
  assert.equal(remote.check(far('1.1.1.1')).allowed, true);
  assert.equal(remote.check(far('2.2.2.2')).allowed, false);
  // Only CF-Connecting-IP on a loopback peer: not believed, and not exempt either.
  const tunnel = createRateLimiter(options);
  assert.equal(tunnel.clientKey(withHeaders('127.0.0.1', { 'cf-connecting-ip': '1.1.1.1' })), '127.0.0.1');
  // Configured as the trusted header it is used, from any peer, when it holds exactly one address.
  const cloudflare = createRateLimiter({ ...options, clientAddress: { kind: 'header', name: 'cf-connecting-ip' } });
  assert.equal(cloudflare.clientKey(withHeaders('10.0.0.5', { 'cf-connecting-ip': '1.1.1.1' })), '1.1.1.1');
  assert.equal(cloudflare.clientKey(withHeaders('10.0.0.5', { 'cf-connecting-ip': '1.1.1.1, 2.2.2.2' })), '10.0.0.5');
  assert.equal(cloudflare.clientKey(withHeaders('10.0.0.5', { 'cf-connecting-ip': 'not-an-address' })), '10.0.0.5');
  assert.equal(cloudflare.clientKey(withHeaders('10.0.0.5', { 'x-forwarded-for': '3.3.3.3' })), '10.0.0.5');
});

test('behind a remote proxy visitors are told apart once the trusted hops are configured', () => {
  const options = { limit: 1, windowMs: 1000, now: () => 0 };
  // Not configured: every visitor arrives from the proxy's address and shares one allowance.
  const shared = createRateLimiter({ ...options, clientAddress: { kind: 'auto' } });
  assert.equal(shared.check(request('10.0.0.5', '1.1.1.1')).allowed, true);
  assert.equal(shared.check(request('10.0.0.5', '2.2.2.2')).allowed, false);
  const none = createRateLimiter({ ...options, clientAddress: { kind: 'none' } });
  assert.equal(none.clientKey(request('127.0.0.1', '1.1.1.1')), '127.0.0.1', 'none believes no header at all');
  // One proxy: the last entry is the visitor; anything before it was written by the visitor.
  const one = createRateLimiter({ ...options, clientAddress: { kind: 'x-forwarded-for', trustedHops: 1 } });
  assert.equal(one.clientKey(request('10.0.0.5', '9.9.9.9, 1.1.1.1')), '1.1.1.1');
  // Two proxies (a CDN in front of a load balancer): the visitor is the second entry from the end.
  const two = createRateLimiter({ ...options, clientAddress: { kind: 'x-forwarded-for', trustedHops: 2 } });
  assert.equal(two.clientKey(request('10.0.0.5', '9.9.9.9, 1.1.1.1, 172.16.0.1')), '1.1.1.1');
  assert.equal(two.clientKey(request('10.0.0.5', '1.1.1.1')), '10.0.0.5', 'a chain that is too short is not believed');
  assert.equal(two.clientKey(request('10.0.0.5')), '10.0.0.5');
  // Ports and IPv4-mapped forms are one client.
  assert.equal(one.clientKey(request('10.0.0.5', '1.1.1.1:5123')), '1.1.1.1');
  assert.equal(one.clientKey(request('10.0.0.5', '[2001:db8::1]:443')), '2001:db8::1');
  assert.equal(one.clientKey(request('::ffff:10.0.0.5')), '10.0.0.5');
});

test('the environment chooses the trusted header, and TRUST_PROXY=on keeps its meaning', () => {
  assert.deepEqual(clientAddressConfig({}), { kind: 'auto' });
  assert.deepEqual(clientAddressConfig({ TRUST_PROXY: 'off' }), { kind: 'auto' });
  assert.deepEqual(clientAddressConfig({ TRUST_PROXY: 'on' }), { kind: 'x-forwarded-for', trustedHops: 1 });
  assert.deepEqual(clientAddressConfig({ CLIENT_IP_HEADER: 'none', TRUST_PROXY: 'on' }), { kind: 'none' });
  assert.deepEqual(clientAddressConfig({ CLIENT_IP_HEADER: 'X-Forwarded-For', TRUSTED_PROXY_HOPS: '2' }), {
    kind: 'x-forwarded-for',
    trustedHops: 2,
  });
  assert.deepEqual(clientAddressConfig({ CLIENT_IP_HEADER: 'CF-Connecting-IP' }), {
    kind: 'header',
    name: 'cf-connecting-ip',
  });
  assert.throws(() => clientAddressConfig({ CLIENT_IP_HEADER: 'two words' }), /CLIENT_IP_HEADER/);
  assert.throws(() => clientAddressConfig({ CLIENT_IP_HEADER: 'x-forwarded-for', TRUSTED_PROXY_HOPS: '0' }));
});

test('all clients together meet a ceiling, which a refused client does not use up', () => {
  let time = 0;
  const limiter = createRateLimiter({ limit: 2, globalLimit: 5, windowMs: 1000, now: () => time });
  // One noisy client is refused by its own limit and spends only two of the five.
  for (let attempt = 0; attempt < 10; attempt++) limiter.check(request('1.1.1.1'));
  assert.equal(limiter.check(request('2.2.2.2')).allowed, true);
  assert.equal(limiter.check(request('3.3.3.3')).allowed, true);
  assert.equal(limiter.check(request('4.4.4.4')).allowed, true);
  const refused = limiter.check(request('5.5.5.5'));
  assert.deepEqual(refused, { allowed: false, retryAfterSeconds: 1 }, 'a new address meets the shared ceiling');
  assert.equal(limiter.check(request('127.0.0.1')).allowed, true, 'the server calling itself is never counted');
  time = 1000;
  assert.equal(limiter.check(request('5.5.5.5')).allowed, true);
  // By default the ceiling is twenty times one client's limit; null removes it.
  const byDefault = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
  const allowed = Array.from({ length: 30 }, (_, index) => byDefault.check(request(`8.8.8.${index}`)).allowed);
  assert.equal(allowed.filter(Boolean).length, 20);
  const open = createRateLimiter({ limit: 1, globalLimit: null, windowMs: 1000, now: () => 0 });
  assert.ok(Array.from({ length: 30 }, (_, index) => open.check(request(`8.8.8.${index}`)).allowed).every(Boolean));
});
