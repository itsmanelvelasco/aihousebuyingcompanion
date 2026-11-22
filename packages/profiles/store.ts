import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { safeId } from '../contracts/ids.ts';
import type { Database } from '../db/database.ts';
import { insertUser, listUserIds, readSection, userExists, writeSection } from '../db/profiles.ts';
import { ApiError } from '../http/server.ts';

export const sections = ['details', 'preferences', 'bank-account'] as const;
export type Section = (typeof sections)[number];
// Preserve evolving team fields while requiring explicit synthetic provenance.
export const documentSchema = z.object({ schemaVersion: z.literal(1), synthetic: z.literal(true) }).catchall(z.json());
export const profileSchema = z
  .object({
    details: documentSchema,
    preferences: documentSchema,
    'bank-account': documentSchema,
  })
  .strict();
export type Profile = z.infer<typeof profileSchema>;

/** Reject an unsafe ID (400) or an unknown user (404). Every per-user store starts with this. */
export function requireUser(db: Database, id: string) {
  safeId.parse(id);
  if (!userExists(db, id)) throw new ApiError(404, 'User not found');
}

/** Profile storage: a user row and one JSON document per section in the runtime database. */
export function createStore(db: Database) {
  return {
    async list() {
      return listUserIds(db);
    },
    async read(id: string, section: Section) {
      requireUser(db, id);
      return documentSchema.parse(readSection(db, id, section));
    },
    /** Create a user with all three documents, or nothing at all when the user already exists. */
    async create(id: string, input: unknown) {
      const profile = profileSchema.parse(input);
      if (profile.details.id !== id) throw new ApiError(400, 'details.id must match user ID');
      safeId.parse(id);
      db.transaction(() => {
        const now = new Date().toISOString();
        if (!insertUser(db, id, now)) throw new ApiError(409, 'User already exists');
        for (const section of sections) writeSection(db, id, section, profile[section], now);
      });
      return profile;
    },
    async write(id: string, section: Section, input: unknown) {
      const value = documentSchema.parse(input);
      if (section === 'details' && value.id !== id) throw new ApiError(400, 'details.id must match user ID');
      db.transaction(() => {
        requireUser(db, id);
        writeSection(db, id, section, value, new Date().toISOString());
      });
      return value;
    },
  };
}

/**
 * Copy the committed fixtures in `source` (one folder per user with the three section files) into
 * the database. A user that already exists is left alone, so runtime edits are never overwritten.
 * A fixture that cannot be read or does not fit the profile schema is skipped and reported.
 */
export async function seedRuntime(source: string, db: Database) {
  const candidates: { id: string; profile: Profile }[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || !safeId.safeParse(entry.name).success) continue;
    if (userExists(db, entry.name)) continue;
    try {
      const documents = await Promise.all(
        sections.map(async section => [
          section,
          JSON.parse(await readFile(join(source, entry.name, `${section}.json`), 'utf8')),
        ]),
      );
      const profile = profileSchema.parse(Object.fromEntries(documents));
      if (profile.details.id !== entry.name) throw new Error('details.id does not match the folder name');
      candidates.push({ id: entry.name, profile });
    } catch (error) {
      skipped.push({ id: entry.name, reason: error instanceof z.ZodError ? 'invalid profile' : String(error) });
    }
  }
  const seeded = db.transaction(() => {
    const now = new Date().toISOString();
    const added: string[] = [];
    for (const { id, profile } of candidates) {
      // Checked again inside the transaction: another process may have created the user meanwhile.
      if (!insertUser(db, id, now)) continue;
      for (const section of sections) writeSection(db, id, section, profile[section], now);
      added.push(id);
    }
    return added;
  });
  return { seeded, skipped };
}
