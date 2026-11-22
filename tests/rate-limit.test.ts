import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
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
