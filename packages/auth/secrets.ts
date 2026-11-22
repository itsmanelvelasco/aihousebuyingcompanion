import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Small helpers for the secrets `packages/auth` hands out. Only hashes of them are ever stored. */

/** A new unguessable secret: 256 random bits, URL-safe, with a prefix that names what it is. */
export function newSecret(prefix: string) {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

/** SHA-256 of a high-entropy secret, as stored in the database. Not for passwords: see `passwords.ts`. */
export function hashSecret(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}

/** Compare two strings without revealing where they differ. */
export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The CSRF token of a browser session: an HMAC keyed with the session id (or, before sign-in, with
 * the pre-session id). Pages put it in a hidden form field; a cross-site page cannot read the
 * HttpOnly cookie, so it cannot compute the token.
 */
export function csrfToken(sessionSecret: string) {
  return createHmac('sha256', sessionSecret).update('relocat-csrf-v1').digest('base64url');
}

export function verifyCsrf(sessionSecret: string | undefined, submitted: unknown) {
  if (!sessionSecret || typeof submitted !== 'string') return false;
  return safeEqual(csrfToken(sessionSecret), submitted);
}

/** PKCE S256: BASE64URL(SHA256(code_verifier)), compared in constant time. */
export function verifyPkce(codeVerifier: string, codeChallenge: string) {
  return safeEqual(createHash('sha256').update(codeVerifier).digest('base64url'), codeChallenge);
}
