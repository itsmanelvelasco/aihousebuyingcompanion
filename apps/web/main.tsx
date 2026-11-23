import { App, applyDocumentTheme } from '@modelcontextprotocol/ext-apps';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CallTool } from './client.ts';
import { createToolClient, httpCallTool } from './client.ts';
import { Wordmark } from './components/bits.tsx';
import { fixtureCallTool } from './fixtures/client.ts';
import { fixturePlan } from './fixtures/plan.ts';
import type { WorkspaceLaunch } from './launch.ts';
import { emptyLaunch, launchRequestFromQuery, parseLaunch } from './launch.ts';
import { Workspace } from './Workspace.tsx';

const requestOptions = { timeout: 20_000 };
const LAUNCH_TIMEOUT_MS = 15_000;

type Connection = { app: App | null; connected: boolean; failed: boolean };

/**
 * Inside a chat host: tools go through the host, and the launch arrives as the tool result.
 * (The package's `/react` entry has a `useApp` hook, but its type declarations do not resolve under
 * this repository's NodeNext settings, so the connection is made here with the same `App` class.)
 */
function Hosted() {
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
    };
    setConnection({ app: created, connected: false, failed: false });
    created.connect(undefined, requestOptions).then(
      () => {
        if (!active) return;
        const theme = created.getHostContext()?.theme;
        if (theme) applyDocumentTheme(theme);
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
  }, []);

  const client = useMemo(() => {
    if (!app) return null;
    const call: CallTool = (name, args) => app.callServerTool({ name, arguments: args }, requestOptions);
    return createToolClient(call);
  }, [app]);

  if (failed)
    return (
      <Shell>
        <p className="rc-note rc-note--error" role="alert">
          <strong>Could not connect to the chat.</strong> Reopen the ReloCat workspace to try again.
        </p>
      </Shell>
    );
  if (!client || !connected || !launch)
    return (
      <Shell>
        <p className="rc-note" role="status">
          Opening the workspace…
        </p>
      </Shell>
    );
  return <Workspace client={client} launch={launch} mode="host" />;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main>
      <header className="masthead">
        <Wordmark />
        <h1>How soon could you buy?</h1>
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
  const query = new URLSearchParams(window.location.search);
  const fixture = query.get('fixture');
  const theme = query.get('theme');
  if (theme === 'dark' || theme === 'light') applyDocumentTheme(theme);
  const client = useMemo(
    () =>
      createToolClient(
        fixture !== null ? fixtureCallTool(fixture) : httpCallTool(new URL('/mcp', window.location.href).href),
      ),
    [fixture],
  );
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
    client.launch(request).then(
      result => active && setLaunch(result),
      // A server without the tool still gets a usable workspace: nobody selected, the places kept.
      () => active && setLaunch({ ...emptyLaunch, municipalityCodes: request.municipalityCodes }),
    );
    return () => {
      active = false;
    };
  }, [client, fixture]);
  if (!launch)
    return (
      <Shell>
        <p className="rc-note" role="status">
          Opening the workspace…
        </p>
      </Shell>
    );
  return <Workspace client={client} launch={launch} mode={fixture !== null ? 'fixture' : 'standalone'} />;
}

// A fixture preview is always standalone, even when the page is shown inside a frame.
const hosted = window.parent !== window && !new URLSearchParams(window.location.search).has('fixture');
createRoot(document.getElementById('root')!).render(hosted ? <Hosted /> : <Standalone />);
