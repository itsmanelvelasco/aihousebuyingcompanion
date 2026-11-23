# Languages

ReloCat is written in English (`en`, the source and fallback), Catalan (`ca`) and Spanish (`es`).

## Rules

- Every text a person reads comes from a catalog. No sentence is written inline in a component, a
  template or a function that returns text for display.
- With no language stated, everything prints exactly the English it printed before. Tests that
  assert English text stay valid; a function that gains a `locale` parameter defaults it to `en`.
- A catalog lives next to the code that uses it, in a file named `messages.ts` (or
  `<name>.messages.ts`), written with `defineMessages`. `tests/i18n.test.ts` finds every such file
  and fails when the three languages differ in keys or placeholders.
- Messages are whole sentences with `{name}` placeholders and
  `{count, plural, one {…} other {…}}`. Never build a sentence by joining translated fragments:
  word order differs between the languages.
- Money, counts, percentages, lists, dates and durations are formatted with `createFormat(locale)`
  and passed in as values: no `Intl.NumberFormat`, `Intl.ListFormat` or `toLocaleString` elsewhere.
  Unknown stays a word (`format.unknown`), never zero.
- Not translated: the product name ReloCat, place names, official names of administrations and
  programmes, identifiers, codes, and what a person typed.
- Text written for the model (tool descriptions, server instructions) stays in English. It tells
  the model to answer in the person's language.

## Which language

| Where | Order of preference |
|---|---|
| Server-rendered page | `?lang=` (also stored in the `rc_lang` cookie), the cookie, `Accept-Language` — `requestLocale` |
| Page or widget in the browser | `?lang=`, the stored choice, the chat host's locale, `<html lang>` when not English, `navigator.languages` — `browserLocale` |
| Tool result | the tool's optional `locale` argument, then `_meta["openai/locale"]` — `toolLocale` |

A language switcher is `languageSwitcher` on a server-rendered page (links with `?lang=`) and three
buttons inside a `.rc-lang` element in a widget (`rememberLocale` stores the choice).

## Files

- `locales.ts`: the three languages, `negotiateLocale`, `toLocale`.
- `messages.ts`: `defineMessages`, `translator`, `formatMessage`, `catalogProblems`.
- `format.ts`: `createFormat(locale)`, the one formatter: `euros`, `eurosExact`, `eurosAuto` (cents
  only when there are some), `money(amount, currency)` for a statement in another currency,
  `monthly`, `count`, `decimal`, `number`, `share` (whole percentage), `percent` (up to two
  decimals), `list` (the language's conjunction), `date`, `clock`, `duration`, `durationShort`.
  `packages/places/wording.ts` delegates to it for the sentences of the domain packages, where
  English keeps the plain forms those sentences always printed.
- `common.ts`: the words every surface shares.
- `browser.ts`: `browserLocale`, `rememberLocale`.
- `server.ts`: `requestLocale`, `localeCookie`, `toolLocale`, `localizeHtml`, `languageSwitcher`.
