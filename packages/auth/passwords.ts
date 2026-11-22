import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with scrypt from `node:crypto`: a random 16-byte salt per password and the cost
 * parameters stored next to the hash, so they can be raised later without invalidating old hashes.
 * Stored form: `scrypt$N$r$p$<salt base64url>$<hash base64url>`.
 */
const current = { N: 2 ** 15, r: 8, p: 1 };
const keyLength = 32;
/** Upper bounds accepted when reading a stored hash, so a corrupted row cannot ask for unbounded work. */
const limits = { N: 2 ** 17, r: 16, p: 4 };

function derive(password: string, salt: Buffer, cost: { N: number; r: number; p: number }) {
  return new Promise<Buffer>((resolve, reject) => {
    // scrypt needs about 128 * N * r bytes; the default 32 MiB ceiling is too low for N = 2^15.
    const options = { ...cost, maxmem: 256 * cost.N * cost.r };
    scrypt(password.normalize('NFKC'), salt, keyLength, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, current);
  return ['scrypt', current.N, current.r, current.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

const within = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;

/** True when `password` matches the stored hash. A malformed hash never matches. Constant-time compare. */
export async function verifyPassword(password: string, stored: string) {
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  const cost = { N: Number(N), r: Number(r), p: Number(p) };
  const valid =
    scheme === 'scrypt' &&
    within(cost.N, 2 ** 14, limits.N) &&
    (cost.N & (cost.N - 1)) === 0 &&
    within(cost.r, 1, limits.r) &&
    within(cost.p, 1, limits.p) &&
    Boolean(salt) &&
    Boolean(hash);
  if (!valid) return false;
  const expected = Buffer.from(hash, 'base64url');
  if (expected.length !== keyLength) return false;
  const actual = await derive(password, Buffer.from(salt, 'base64url'), cost);
  return timingSafeEqual(actual, expected);
}

/** True when the hash was made with other parameters than today's and should be replaced at sign-in. */
export function needsRehash(stored: string) {
  const [, N, r, p] = stored.split('$');
  return Number(N) !== current.N || Number(r) !== current.r || Number(p) !== current.p;
}

let decoy: Promise<string> | undefined;
/** A hash of a random password, verified when the email is unknown so both cases take the same time. */
export function decoyHash() {
  decoy ??= hashPassword(randomBytes(24).toString('base64url'));
  return decoy;
}
