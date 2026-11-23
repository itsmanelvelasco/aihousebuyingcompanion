import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { chooseLocale } from '../packages/i18n/browser.ts';
import { common } from '../packages/i18n/common.ts';
import { createFormat } from '../packages/i18n/format.ts';
import { acceptedLanguages, locales, negotiateLocale, toLocale } from '../packages/i18n/locales.ts';
import {
  type Catalog,
  catalogProblems,
  defineMessages,
  formatMessage,
  placeholders,
  translator,
} from '../packages/i18n/messages.ts';
import { languageSwitcher, localeCookie, localizeHtml, requestLocale, toolLocale } from '../packages/i18n/server.ts';
import { wording } from '../packages/places/wording.ts';

const root = resolve(import.meta.dirname, '..');

/** Every catalog file of the repository: `messages.ts` or `<name>.messages.ts`, plus the shared one. */
function catalogFiles(directory: string, found: string[] = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) catalogFiles(path, found);
    else if (/(^|\.)messages\.ts$/.test(entry.name) && !path.includes(join('packages', 'i18n'))) found.push(path);
  }
  return found;
}

const isCatalog = (value: unknown): value is Catalog =>
  typeof value === 'object' &&
  value !== null &&
  locales.every(locale => typeof (value as Catalog)[locale] === 'object');

test('every catalog has the same keys and placeholders in English, Catalan and Spanish', async () => {
  assert.deepEqual(catalogProblems(common), []);
  const files = [...catalogFiles(join(root, 'apps')), ...catalogFiles(join(root, 'packages'))];
  for (const file of files) {
    const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const catalogs = Object.entries(module).filter(([, value]) => isCatalog(value));
    assert.ok(catalogs.length > 0, `${relative(root, file)} exports no catalog`);
    for (const [name, catalog] of catalogs)
      assert.deepEqual(catalogProblems(catalog as Catalog), [], `${relative(root, file)} → ${name}`);
  }
});

test('a translation that drops a key or a placeholder is reported', () => {
  const broken = {
    en: { hello: 'Hello {name}', count: '{n, plural, one {# place} other {# places}}' },
    ca: { hello: 'Hola', count: '{n, plural, one {# lloc} other {# llocs}}', extra: 'x' },
    es: { hello: 'Hola {name}', count: '' },
  } as unknown as Catalog;
  assert.deepEqual(catalogProblems(broken), [
    'ca.hello: placeholders {} differ from English {name}',
    'ca.extra: not in English',
    'es.count: missing or empty',
  ]);
  assert.deepEqual(placeholders('{a} and {n, plural, one {# {b}} other {#}}'), ['a', 'b', 'n']);
});

test('messages fill values and pick the plural of the language', () => {
  const catalog = defineMessages(
    {
      places: '{count, plural, one {# place} other {# places}} for {name}',
      none: '{count, plural, =0 {none} other {#}}',
    },
    {
      ca: {
        places: '{count, plural, one {# lloc} other {# llocs}} per a {name}',
        none: '{count, plural, =0 {cap} other {#}}',
      },
      es: {
        places: '{count, plural, one {# lugar} other {# lugares}} para {name}',
        none: '{count, plural, =0 {ninguno} other {#}}',
      },
    },
  );
  assert.equal(translator(catalog, 'en')('places', { count: 1, name: 'Ada' }), '1 place for Ada');
  assert.equal(translator(catalog, 'ca')('places', { count: 2, name: 'Ada' }), '2 llocs per a Ada');
  assert.equal(translator(catalog, 'es')('places', { count: 1200, name: 'Ada' }), '1200 lugares para Ada');
  assert.equal(translator(catalog, 'es')('none', { count: 0 }), 'ninguno');
  // A missing value stays visible instead of printing "undefined".
  assert.equal(formatMessage('Hello {name}', {}), 'Hello {name}');
  assert.equal(formatMessage('{count, plural, one {#} other {#}}', {}), '{count, plural, one {#} other {#}}');
});

test('the language is negotiated from the most explicit source that names one of the three', () => {
  assert.equal(toLocale('ca-ES'), 'ca');
  assert.equal(toLocale('ES_es'), 'es');
  assert.equal(toLocale('fr'), undefined);
  assert.deepEqual(acceptedLanguages('fr;q=0.9, ca-ES, en;q=0, es;q=0.8, *;q=0.1'), ['ca-ES', 'fr', 'es']);
  assert.equal(negotiateLocale('fr-FR, es;q=0.7, ca;q=0.9'), 'ca');
  assert.equal(negotiateLocale(null, 'de', ['pt', 'es-MX']), 'es');
  assert.equal(negotiateLocale(undefined, 'fr'), 'en');

  assert.equal(chooseLocale({ search: '?lang=ca', stored: 'es', hostLocale: 'en-US' }), 'ca');
  assert.equal(chooseLocale({ search: '?lang=xx', stored: 'es', hostLocale: 'ca' }), 'es');
  assert.equal(chooseLocale({ hostLocale: 'ca-ES', languages: ['es'] }), 'ca');
  assert.equal(chooseLocale({ documentLang: 'es', languages: ['ca'] }), 'es');
  // English on <html lang> is the template default, not a choice: the browser's language decides.
  assert.equal(chooseLocale({ documentLang: 'en', languages: ['ca-ES', 'en'] }), 'ca');
  assert.equal(chooseLocale({}), 'en');
});

test('a page request takes ?lang, then the cookie, then Accept-Language; a tool call takes its argument, then the host', () => {
  const request = (url: string, headers: Record<string, string> = {}) => ({ url, headers }) as never;
  assert.deepEqual(requestLocale(request('/connect?lang=es', { cookie: 'rc_lang=ca' })), {
    locale: 'es',
    chosen: true,
  });
  assert.deepEqual(requestLocale(request('/connect', { cookie: 'a=b; rc_lang=ca', 'accept-language': 'es' })), {
    locale: 'ca',
    chosen: false,
  });
  assert.deepEqual(requestLocale(request('/connect?lang=zz', { 'accept-language': 'es-ES,es;q=0.9' })), {
    locale: 'es',
    chosen: false,
  });
  assert.deepEqual(requestLocale(request('/connect')), { locale: 'en', chosen: false });
  assert.equal(localeCookie('ca', true), 'rc_lang=ca; Path=/; Max-Age=31536000; SameSite=Lax; Secure');

  assert.equal(toolLocale('ca', { 'openai/locale': 'es-ES' }), 'ca');
  assert.equal(toolLocale(undefined, { 'openai/locale': 'es-ES' }), 'es');
  assert.equal(toolLocale(undefined, { locale: 'ca' }), 'ca');
  assert.equal(toolLocale('klingon', null), 'en');
});

test('a template is written in one language, escaped, with a switcher that keeps the query', () => {
  const catalog = defineMessages(
    { title: 'Find <your> place', rich: 'Read the <a href="/x">guide</a>' },
    {
      ca: { title: 'Troba el teu lloc', rich: 'Llegeix la <a href="/x">guia</a>' },
      es: { title: 'Encuentra tu lugar', rich: 'Lee la <a href="/x">guía</a>' },
    },
  );
  const template = '<html lang="en"><h1>{{t:title}}</h1><p>{{t-html:rich}}</p><!-- LANGUAGES --></html>';
  const english = localizeHtml(template, catalog, 'en', { path: '/connect' });
  assert.match(english, /<h1>Find &#60;your&#62; place<\/h1>/);
  const catalan = localizeHtml(template, catalog, 'ca', { path: '/connect?next=%2Fa&lang=en' });
  assert.match(catalan, /^<html lang="ca"><h1>Troba el teu lloc<\/h1><p>Llegeix la <a href="\/x">guia<\/a><\/p>/);
  assert.match(catalan, /<nav class="rc-lang" aria-label="Idioma">/);
  assert.match(
    catalan,
    /<a href="\/connect\?next=%2Fa&#38;lang=ca" lang="ca" hreflang="ca" aria-current="true">Català<\/a>/,
  );
  assert.match(catalan, /<a href="\/connect\?next=%2Fa&#38;lang=es" lang="es" hreflang="es">Castellano<\/a>/);
  assert.throws(() => localizeHtml('{{t:nope}}', catalog, 'en'), /Unknown message "nope"/);
  assert.match(languageSwitcher('es', '/'), /aria-current="true">Castellano</);
});

test('numbers, money, dates and durations are written as each language writes them; unknown is a word', () => {
  const en = createFormat('en');
  const ca = createFormat('ca');
  const es = createFormat('es');
  // English is what the product printed before it had other languages.
  assert.equal(en.euros(12_345_600), '€123,456');
  assert.equal(en.monthly(120_000), '€1,200/month');
  assert.equal(en.date('2026-11-23'), '23 Nov 2026');
  assert.equal(en.duration(50), '4 years 2 months');
  assert.equal(en.duration(1), '1 month');
  assert.equal(en.duration(null), 'No finite timeline');
  assert.equal(en.duration(0), 'Already reached');
  assert.equal(en.durationShort(50), '4 y 2 mo');
  assert.equal(en.share(0.2), '20%');
  assert.equal(en.euros(null), 'Unknown');

  const plain = (text: string) => text.replace(/[  ]/g, ' ');
  assert.equal(plain(ca.euros(12_345_600)), '123.456 €');
  assert.equal(plain(es.monthly(120_000)), '1200 €/mes');
  assert.equal(ca.duration(50), '4 anys i 2 mesos');
  assert.equal(es.duration(13), '1 año y 1 mes');
  assert.equal(ca.duration(null), 'Sense termini finit');
  assert.equal(es.count(undefined), 'Desconocido');
  assert.equal(plain(es.share(0.2)), '20 %');
  assert.match(ca.date('2026-11-23'), /23/);
  assert.equal(en.date('not a date'), 'not a date');
});

test('one formatter writes cents when present, rates with decimals, lists and other currencies', () => {
  const en = createFormat('en');
  const ca = createFormat('ca');
  const es = createFormat('es');
  const plain = (text: string) => text.replace(/[  ]/g, ' ');
  // Cents only when there are some.
  assert.equal(en.eurosAuto(95_000), '€950');
  assert.equal(en.eurosAuto(95_050), '€950.50');
  assert.equal(plain(ca.eurosAuto(95_000)), '950 €');
  assert.equal(plain(es.eurosAuto(95_050)), '950,50 €');
  assert.equal(es.eurosAuto(null), 'Desconocido');
  // A rate keeps up to two decimals; `share` stays a whole percentage.
  assert.equal(en.percent(0.0225), '2.25%');
  assert.equal(en.percent(0.05), '5%');
  assert.equal(plain(ca.percent(0.0225)), '2,25 %');
  assert.equal(en.share(0.0225), '2%');
  assert.equal(ca.percent(undefined), 'Desconegut');
  assert.equal(en.number(1234.567), '1,234.57');
  assert.equal(plain(es.number(12345.5)), '12.345,5');
  // Lists take the language's own conjunction.
  assert.equal(en.list(['schools', 'trains', 'shops']), 'schools, trains and shops');
  assert.equal(ca.list(['escoles', 'trens', 'botigues']), 'escoles, trens i botigues');
  assert.equal(es.list(['escuelas', 'trenes']), 'escuelas y trenes');
  assert.equal(en.list(['schools']), 'schools');
  // A statement keeps its own currency; euros read as `eurosExact` writes them.
  assert.equal(en.money(1234.5, 'EUR'), en.eurosExact(123_450));
  assert.equal(en.money(1234.5, 'EUR'), '€1,234.50');
  assert.equal(en.money(12.5, 'USD'), 'US$12.50');
  assert.equal(plain(es.money(12.5, 'GBP')), '12,50 GBP');
  assert.equal(ca.money(null, 'USD'), 'Desconegut');

  // The sentences of the domain packages delegate: English as given, the other languages formatted.
  const english = wording('en');
  const catalan = wording('ca');
  assert.equal(english.euros(8_831_800, '€88318'), '€88318');
  assert.equal(catalan.euros(8_831_850, '€88318.5'), ca.eurosAuto(8_831_850));
  assert.equal(english.percent(0.0225), '2.25%');
  assert.equal(catalan.percent(0.0225), ca.percent(0.0225));
  assert.equal(catalan.number(1234.5), ca.number(1234.5));
  assert.equal(english.list(['a', 'b'], ' / '), 'a / b');
  assert.equal(catalan.list(['a', 'b'], ' / '), 'a i b');
  assert.doesNotMatch(readFileSync(new URL('../packages/places/wording.ts', import.meta.url), 'utf8'), /Intl\./);
});
