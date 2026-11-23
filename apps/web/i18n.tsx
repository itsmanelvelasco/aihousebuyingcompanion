import type { ReactNode } from 'react';
import { createContext, Fragment, useContext, useMemo } from 'react';
import { common } from '../../packages/i18n/common.ts';
import { defaultLocale, type Locale, localeNames, locales } from '../../packages/i18n/locales.ts';
import { type Catalog, type Translate, translator } from '../../packages/i18n/messages.ts';

/**
 * The one language of the workspace. It is chosen at boot (`browserLocale` in `main.tsx`), held in
 * React state and read by every component through these hooks, so a change re-renders everything.
 */
type LanguageState = { locale: Locale; setLocale: (locale: Locale) => void };

export const LanguageContext = createContext<LanguageState>({ locale: defaultLocale, setLocale: () => undefined });

export const useLocale = () => useContext(LanguageContext).locale;

/** `t('key', values)` for one catalog in the language on screen. */
export function useMessages<Key extends string>(catalog: Catalog<Key>): Translate<Key> {
  const locale = useLocale();
  return useMemo(() => translator(catalog, locale), [catalog, locale]);
}

/** Three buttons, each language named in itself; the current one is pressed. */
export function LanguageSwitcher() {
  const { locale, setLocale } = useContext(LanguageContext);
  const t = useMessages(common);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a form fieldset.
    <div className="rc-lang" role="group" aria-label={t('language')}>
      {locales.map(option => (
        <button
          key={option}
          type="button"
          lang={option}
          aria-pressed={option === locale}
          onClick={() => setLocale(option)}
        >
          {localeNames[option]}
        </button>
      ))}
    </div>
  );
}

type Parts = Record<string, ReactNode | ((children: ReactNode) => ReactNode)>;

/**
 * A message with markup as React nodes. `<b>…</b>` in the text is handed to `parts.b` as a
 * function of its content, and a `{name}` the translator left unfilled is replaced by the node
 * `parts.name`. Text that comes from the server or from the person is passed as a node, never
 * written into the message, so nothing in it is read as markup.
 */
export function rich(text: string, parts: Parts = {}): ReactNode {
  const nodes: ReactNode[] = [];
  const pattern = /<(\w+)>([\s\S]*?)<\/\1>|\{(\w+)\}/g;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const [whole, tag, inner, name] = match;
    const part = parts[tag ?? name];
    if (part === undefined) continue;
    if (match.index > index) nodes.push(text.slice(index, match.index));
    nodes.push(
      <Fragment key={match.index}>
        {tag !== undefined && typeof part === 'function' ? part(rich(inner, parts)) : (part as ReactNode)}
      </Fragment>,
    );
    index = match.index + whole.length;
  }
  if (index < text.length) nodes.push(text.slice(index));
  return nodes;
}

/** The bold lead-in of a note. */
export const bold = (children: ReactNode) => <strong>{children}</strong>;
/** Text for screen readers only. */
export const srOnly = (children: ReactNode) => <span className="rc-sr-only">{children}</span>;
