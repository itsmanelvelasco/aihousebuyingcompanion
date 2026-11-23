import { z } from 'zod';

/**
 * The optional `locale` argument of the tools that return text for display. Absent: the language
 * the chat host states in `_meta["openai/locale"]`, else English (`toolLocale` in `packages/i18n`).
 */
export const localeArgument = z
  .enum(['en', 'ca', 'es'])
  .optional()
  .describe(
    'Language of the display text in the result: en, ca (Catalan) or es (Spanish). Pass the language the person writes in. Codes, ids and numbers do not change.',
  );
