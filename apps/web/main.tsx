import { App, applyDocumentTheme } from '@modelcontextprotocol/ext-apps';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browserLocale, rememberLocale } from '../../packages/i18n/browser.ts';
import type { Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import type { CallTool } from './client.ts';
import { createToolClient, httpCallTool } from './client.ts';
import { Wordmark } from './components/bits.tsx';
import { fixtureCallTool } from './fixtures/client.ts';
import { fixturePlan } from './fixtures/plan.ts';
import { bold, LanguageContext, LanguageSwitcher, rich, useLocale, useMessages } from './i18n.tsx';
import type { WorkspaceLaunch } from './launch.ts';
import { emptyLaunch, launchRequestFromQuery, parseLaunch } from './launch.ts';
import { workspaceMessages } from './messages/workspace.messages.ts';
import { Workspace } from './Workspace.tsx';

const requestOptions = { timeout: 20_000 };
const LAUNCH_TIMEOUT_MS = 15_000;

type Connection = { app: App | null; connected: boolean; failed: boolean };

/**
 * Inside a chat host: tools go through the host, and the launch arrives as the tool result.
 * (The package's `/react` entry has a `useApp` hook, but its type declarations do not resolve under
 * this repository's NodeNext settings, so the connection is made here with the same `App` class.)
 */
function Hosted({ onHostLocale }: { onHostLocale: (locale: string | undefined) => void }) {
  const locale = useLocale();
  const t = useMessages(workspaceMessages);
  const [launch, setLaunch] = useState<WorkspaceLaunch | null>(null);
  const [{ app, connected, failed }, setConnection] = useState<Connection>({
    app: null,
    connected: false,
    failed: false,
  });

  useEffect(() => {
    const created = new App({ name: 'ReloCat Workspace', version: '1.0.0' });
    let active = true;
    // Handlers are set before connecting so the first tool result is not missed.
    created.ontoolresult = result => setLaunch(parseLaunch(result.structuredContent));
    created.onhostcontextchanged = context => {
      if (context.theme) applyDocumentTheme(context.theme);
      if (context.locale) onHostLocale(context.locale);
    };
    setConnection({ app: created, connected: false, failed: false });
    created.connect(undefined, requestOptions).then(
      () => {
        if (!active) return;
        const context = created.getHostContext();
        if (context?.theme) applyDocumentTheme(context.theme);
        onHostLocale(context?.locale);
        setConnection({ app: created, connected: true, failed: false });
      },
      () => {
        if (active) setConnection({ app: created, connected: false, failed: true });
      },
    );
    // A host that never sends the tool result still gets a usable, empty workspace.
    const timer = setTimeout(() => setLaunch(current => current ?? emptyLaunch), LAUNCH_TIMEOUT_MS);
    // Source links leave the sandboxed frame through the host when it can open them.
    const onClick = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || !created.getHostCapabilities()?.openLinks) return;
      event.preventDefault();
      void created.openLink({ url: anchor.href }, requestOptions).catch(() => undefined);
    };
    document.addEventListener('click', onClick);
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener('click', onClick);
    };
  }, [onHostLocale]);

  const client = useMemo(() => {
    if (!app) return null;
    const call: CallTool = (name, args) => app.callServerTool({ name, arguments: args }, requestOptions);
    return createToolClient(call, locale);
  }, [app, locale]);

  if (failed)
    return (
      <Shell>
        <p className="rc-note rc-note--error" role="alert">
          {rich(t('connectFailed'), { b: bold })}
        </p>
      </Shell>
    );
  if (!client || !connected || !launch)
    return (
      <Shell>
        <p className="rc-note" role="status">
          {t('opening')}
        </p>
      </Shell>
    );
  return <Workspace client={client} launch={launch} mode="host" />;
}

function Shell({ children }: { children: ReactNode }) {
  const t = useMessages(workspaceMessages);
  return (
    <main>
      <header className="masthead">
        <div className="masthead-top">
          <Wordmark />
          <LanguageSwitcher />
        </div>
        <h1>{t('heading')}</h1>
      </header>
      {children}
    </main>
  );
}

/**
 * Outside a chat host. `?fixture=1` shows the hand-written sample (other values pick a state to
 * inspect); otherwise the page calls the MCP endpoint on its own origin with the session cookie.
 * Who is shown is the server's answer to `show_workspace`: the signed-in person, the demo persona
 * named with `?demo=`, or nobody. The page never names a user id.
 */
function Standalone() {
  const locale = useLocale();
  const t = useMessages(workspaceMessages);
  const query = new URLSearchParams(window.location.search);
  const fixture = query.get('fixture');
  const theme = query.get('theme');
  if (theme === 'dark' || theme === 'light') applyDocumentTheme(theme);
  // The fixture keeps its own state between calls, so it is made once and outlives a change of language.
  const fixtureCall = useMemo(() => (fixture !== null ? fixtureCallTool(fixture) : null), [fixture]);
  const client = useMemo(
    () =>
      createToolClient(
        fixtureCall ?? httpCallTool(new URL('/mcp', window.location.href).href, undefined, locale),
        locale,
      ),
    [fixtureCall, locale],
  );
  // The launch is asked for once; a later change of language only makes a new client.
  const launching = useRef(client);
  const [launch, setLaunch] = useState<WorkspaceLaunch | null>(null);
  useEffect(() => {
    let active = true;
    const request = launchRequestFromQuery(window.location.search);
    const blank = new URLSearchParams(window.location.search).has('blank');
    // The fixture opens on its sample persona unless the address asks for something else.
    if (fixture !== null && !request.demoId && !request.municipalityCodes.length && !blank) {
      request.demoId = fixturePlan.person.id;
      request.municipalityCodes = fixturePlan.plans.map(plan => plan.place.municipalityCode);
    }
    launching.current.launch(request).then(
      result => active && setLaunch(result),
      // A server without the tool still gets a usable workspace: nobody selected, the places kept.
      () => active && setLaunch({ ...emptyLaunch, municipalityCodes: request.municipalityCodes }),
    );
    return () => {
      active = false;
    };
  }, [fixture]);
  if (!launch)
    return (
      <Shell>
        <p className="rc-note" role="status">
          {t('opening')}
        </p>
      </Shell>
    );
  return <Workspace client={client} launch={launch} mode={fixture !== null ? 'fixture' : 'standalone'} />;
}

// A fixture preview is always standalone, even when the page is shown inside a frame.
const hosted = window.parent !== window && !new URLSearchParams(window.location.search).has('fixture');

/**
 * Holds the one language of the widget. At boot it is what `browserLocale` decides (`?lang=`, an
 * earlier choice, the chat host, the browser); the switcher changes it and remembers the choice,
 * and from then on what the host states no longer moves it.
 */
function Root() {
  const [locale, setLocale] = useState<Locale>(() => browserLocale());
  const chosen = useRef(false);
  const language = useMemo(
    () => ({
      locale,
      setLocale: (next: Locale) => {
        chosen.current = true;
        rememberLocale(next);
        setLocale(next);
      },
    }),
    [locale],
  );
  const onHostLocale = useCallback((hostLocale: string | undefined) => {
    if (!chosen.current) setLocale(browserLocale(hostLocale));
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = translator(workspaceMessages, locale)('documentTitle');
  }, [locale]);
  return (
    <LanguageContext.Provider value={language}>
      {hosted ? <Hosted onHostLocale={onHostLocale} /> : <Standalone />}
    </LanguageContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<Root />);
