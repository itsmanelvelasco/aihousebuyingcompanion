import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { safeId } from '../contracts/ids.ts';
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

export function createStore(root: string) {
  function directory(id: string) {
    return join(root, safeId.parse(id));
  }
  async function exists(id: string) {
    try {
      await readFile(join(directory(id), 'details.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'User not found');
      throw error;
    }
  }
  return {
    async list() {
      await mkdir(root, { recursive: true });
      const entries = await readdir(root, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory() && safeId.safeParse(e.name).success)
        .map(e => e.name)
        .sort();
    },
    async read(id: string, section: Section) {
      await exists(id);
      return documentSchema.parse(JSON.parse(await readFile(join(directory(id), `${section}.json`), 'utf8')));
    },
    async create(id: string, input: unknown) {
      const profile = profileSchema.parse(input);
      if (profile.details.id !== id) throw new ApiError(400, 'details.id must match user ID');
      await mkdir(root, { recursive: true });
      const staging = join(root, `.staging-${randomUUID()}`);
      await mkdir(staging);
      try {
        for (const section of sections)
          await writeFile(join(staging, `${section}.json`), `${JSON.stringify(profile[section], null, 2)}\n`, {
            mode: 0o600,
          });
        try {
          await rename(staging, directory(id));
        } catch (error) {
          if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            try {
              await exists(id);
            } catch {
              throw error;
            }
            throw new ApiError(409, 'User already exists');
          }
          throw error;
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      return profile;
    },
    async write(id: string, section: Section, input: unknown) {
      const value = documentSchema.parse(input);
      if (section === 'details' && value.id !== id) throw new ApiError(400, 'details.id must match user ID');
      await exists(id);
      const target = join(directory(id), `${section}.json`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
      return value;
    },
  };
}

export async function seedRuntime(source: string, target: string) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || !safeId.safeParse(entry.name).success) continue;
    // Never overwrite an existing runtime user's edits.
    try {
      await mkdir(join(target, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    await cp(join(source, entry.name), join(target, entry.name), { recursive: true });
  }
}
