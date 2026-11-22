import { z } from 'zod';

/** Lowercase slug used for users, accounts, movements, goals and other stored records. */
export const safeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
