import { rememberLocale } from '../../packages/i18n/browser.ts';
import { common } from '../../packages/i18n/common.ts';
import { type Locale, localeNames, locales } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';

/**
 * Language plumbing shared by the bundled widgets of this server (browser only).
 *
 * A template marks its static text: `data-i18n="key"` sets the element's text, and
 * `data-i18n-attr="aria-label:key; title:otherKey"` sets attributes. The template itself is
 * written in English, so a widget whose script fails still reads correctly.
 */
export function applyMessages(root: ParentNode, t: (key: never) => string) {
  const text = t as (key: string) => string;
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]'))
    element.textContent = text(element.dataset.i18n ?? '');
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n-attr]'))
    for (const pair of (element.dataset.i18nAttr ?? '').split(';')) {
      const [attribute, key] = pair.split(':').map(part => part.trim());
      if (attribute && key) element.setAttribute(attribute, text(key));
    }
}

/**
 * Fills a `.rc-lang` element with one button per language. A click stores the choice
 * (`rememberLocale`) and calls `onChoose`; the returned function marks the language now shown.
 */
export function mountLanguages(container: HTMLElement, onChoose: (locale: Locale) => void) {
  container.setAttribute('role', 'group');
  const buttons = locales.map(locale => {
    const button = document.createElement('button');
    button.type = 'button';
    button.lang = locale;
    button.textContent = localeNames[locale];
    button.addEventListener('click', () => {
      rememberLocale(locale);
      onChoose(locale);
    });
    return button;
  });
  container.replaceChildren(...buttons);
  return (current: Locale) => {
    container.setAttribute('aria-label', translator(common, current)('language'));
    buttons.forEach((button, index) => {
      button.setAttribute('aria-pressed', String(locales[index] === current));
    });
  };
}

type ToolAnswer = { isError?: boolean; structuredContent?: Record<string, unknown> };

/**
 * Calls a tool and returns its structured answer. With a `locale`, the tool is asked to answer in
 * that language; a server from before the tools took the argument refuses it, so the call is made
 * once more without it and its English text is shown rather than nothing.
 */
export async function readLocalizedTool<Answer extends ToolAnswer>(
  call: (name: string, args: Record<string, unknown>) => Promise<Answer>,
  name: string,
  args: Record<string, unknown>,
  locale: Locale | null,
) {
  const attempt = (input: Record<string, unknown>) => call(name, input).catch(() => null);
  let result = await attempt(locale ? { ...args, locale } : args);
  if (locale && (!result || result.isError)) result = await attempt(args);
  if (!result || result.isError || !result.structuredContent) throw new Error(`Could not read ${name}`);
  return result.structuredContent;
}
