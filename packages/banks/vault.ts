import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/database.ts';
import { readMeta, writeMeta } from '../db/database.ts';

/**
 * Encryption at rest for what a bank's consent flow hands back for a connection.
 *
 * One 256-bit data key (`DATA_ENCRYPTION_KEY`) is split with HKDF into three independent keys:
 *
 *   - `seal` / `open`: AES-256-GCM with a random 96-bit nonce per value. The additional
 *     authenticated data names the row the value belongs to (person, connection, provider), so a
 *     ciphertext copied to another row does not decrypt.
 *   - `fingerprint`: HMAC-SHA256 of a bank reference. It is what the connection row stores instead
 *     of the reference, so "one reference, one person" and webhook lookups work without the
 *     reference in clear, and nobody without the key can test a guessed reference against the file.
 *   - `sign`: HMAC-SHA256 for server-made tokens that must not be forgeable (statement previews).
 *
 * Opening with another key, a changed ciphertext or another row fails closed: `open` throws
 * `VaultError` and nothing is returned.
 */

export class VaultError extends Error {}

export type Vault = {
  /** Encrypt `plaintext` for the row named by `aad`. Returns `v1.<nonce>.<ciphertext>.<tag>`. */
  seal(plaintext: string, aad: string): string;
  /** Decrypt what `seal` returned for the same `aad`. Throws `VaultError` on any mismatch. */
  open(sealed: string, aad: string): string;
  /** A stable, keyed, non-reversible stand-in for a bank reference: `sealed:<64 hex>`. */
  fingerprint(value: string): string;
  /** A keyed signature of `value`, base64url. */
  sign(value: string): string;
  /** True when the key was generated for local development and lives in the database. */
  readonly development: boolean;
};

/** Prefix of a fingerprinted bank reference, as stored in `bank_connections.ref`. */
export const sealedRefPrefix = 'sealed:';

const subkey = (key: Buffer, purpose: string) =>
  Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), `relocat/${purpose}/v1`, 32));

export function createVault(key: Buffer, options: { development?: boolean } = {}): Vault {
  if (key.length !== 32) throw new VaultError('The data encryption key must be 32 bytes');
  const sealing = subkey(key, 'bank-credential');
  const indexing = subkey(key, 'bank-ref-index');
  const signing = subkey(key, 'signature');
  return {
    development: options.development === true,
    seal(plaintext, aad) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', sealing, nonce);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return ['v1', nonce, body, cipher.getAuthTag()]
        .map(part => (typeof part === 'string' ? part : part.toString('base64url')))
        .join('.');
    },
    open(sealed, aad) {
      const [version, nonce, body, tag] = sealed.split('.');
      if (version !== 'v1' || !nonce || body === undefined || !tag) throw new VaultError('Unknown sealed value format');
      try {
        const decipher = createDecipheriv('aes-256-gcm', sealing, Buffer.from(nonce, 'base64url'));
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
      } catch {
        throw new VaultError('The sealed value cannot be opened with this key');
      }
    },
    fingerprint(value) {
      return `${sealedRefPrefix}${createHmac('sha256', indexing).update(value).digest('hex')}`;
    },
    sign(value) {
      return createHmac('sha256', signing).update(value).digest('base64url');
    },
  };
}

/** Compare two signatures without revealing where they differ. */
export function sameSignature(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * `DATA_ENCRYPTION_KEY` as 32 bytes: 64 hexadecimal characters, or base64 / base64url of 32 bytes
 * (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`). Returns
 * undefined when it is unset, and throws when it is set to anything else.
 */
export function parseDataKey(value: string | undefined) {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) {
    const key = Buffer.from(text.replace(/=$/, ''), text.includes('+') || text.includes('/') ? 'base64' : 'base64url');
    if (key.length === 32) return key;
  }
  throw new VaultError('DATA_ENCRYPTION_KEY must be 32 random bytes as 64 hex characters or as base64');
}

const developmentKeyMeta = 'data-encryption.development-key';

/**
 * The vault of a development server without `DATA_ENCRYPTION_KEY`: a random key that is created
 * once and kept in the database's `app_meta`. That protects nothing against somebody who has the
 * database file, since the key is in it, which is why production must be given a key of its own.
 * `notice` is called once, when the key is created.
 */
export function developmentVault(db: Database, notice?: (message: string) => void) {
  let stored = readMeta(db, developmentKeyMeta);
  if (!stored) {
    db.transaction(() => {
      // Another process may have created it while this one waited for the write lock.
      stored = readMeta(db, developmentKeyMeta);
      if (stored) return;
      stored = randomBytes(32).toString('base64url');
      writeMeta(db, developmentKeyMeta, stored);
      notice?.(
        'DATA_ENCRYPTION_KEY is not set: bank credentials are sealed with a development key that is stored in ' +
          'the database itself. Fine for local work; set DATA_ENCRYPTION_KEY before any real bank is connected.',
      );
    });
  }
  return createVault(Buffer.from(stored!, 'base64url'), { development: true });
}

/**
 * A vault that is made the first time it is used. A development server then creates (and announces)
 * its key only once somebody connects a bank, and one that never does stores no key at all.
 */
export function lazyVault(make: () => Vault): Vault {
  let made: Vault | undefined;
  const vault = () => {
    made ??= make();
    return made;
  };
  return {
    get development() {
      return vault().development;
    },
    seal: (plaintext, aad) => vault().seal(plaintext, aad),
    open: (sealed, aad) => vault().open(sealed, aad),
    fingerprint: value => vault().fingerprint(value),
    sign: value => vault().sign(value),
  };
}
