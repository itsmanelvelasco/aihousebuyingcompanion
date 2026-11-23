import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { iconAttributes, iconPaths } from '../../packages/ui/icons.ts';
import { themeCss } from '../../packages/ui/inline.ts';
import { voiceCard } from './voice-card.messages.ts';

/**
 * Used only while `dist/voice-card.js` has not been built: the host handshake written by hand,
 * in English. The built script (`voice-card-widget.ts`) replaces it and adds the other languages.
 */
const fallbackScript = `
  if (window.parent !== window) {
    const send = (method, params, id) =>
      window.parent.postMessage({ jsonrpc: '2.0', method, params, id }, '*');
    window.addEventListener('message', event => {
      if (event.source !== window.parent || event.data?.jsonrpc !== '2.0' ||
          event.data.id !== 1 || !event.data.result) return;
      send('ui/notifications/initialized', {});
      new ResizeObserver(() => send('ui/notifications/size-changed', {
        width: document.documentElement.scrollWidth,
        height: document.querySelector('main').offsetHeight,
      })).observe(document.querySelector('main'));
    });
    send('ui/initialize', {
      appInfo: { name: 'ReloCat Start talking', version: '1.0.0' },
      appCapabilities: {},
      protocolVersion: '2026-01-26',
    }, 1);
  }

  document.querySelector('.launch')?.addEventListener('click', event => {
    if (typeof window.openai?.openExternal !== 'function') return;
    event.preventDefault();
    const link = event.currentTarget;
    try {
      Promise.resolve(window.openai.openExternal({ href: link.href, redirectUrl: false }))
        .catch(showLaunchError);
    } catch { showLaunchError(); }
    function showLaunchError() {
      document.querySelector('#launch-help').hidden = false;
    }
  });
`;

/** The built widget script, or the hand-written fallback when the bundle is missing. */
function widgetScript() {
  let script = fallbackScript;
  try {
    script = readFileSync(new URL('./dist/voice-card.js', import.meta.url), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return script.replace(/<\/script/gi, '<\\/script');
}

/**
 * The card is written in English with `data-i18n` keys of `voice-card.messages.ts`; its script
 * shows it in the person's language and fills the language switcher.
 */
export function renderVoiceCard(launchUrl: string | null) {
  const text = voiceCard.en;
  const said = (key: keyof typeof text) => ({ 'data-i18n': key });
  const control = launchUrl
    ? h(
        'div',
        null,
        h(
          'a',
          {
            className: 'rc-btn rc-btn--gold launch',
            href: launchUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            ...said('start'),
          },
          text.start,
        ),
        h('p', { className: 'help', ...said('opens') }, text.opens),
        h(
          'p',
          { id: 'launch-help', className: 'help', hidden: true, role: 'status', ...said('instructions') },
          text.instructions,
        ),
      )
    : h(
        'details',
        null,
        h('summary', { className: 'rc-btn rc-btn--gold', ...said('start') }, text.start),
        h('p', { className: 'help', ...said('instructions') }, text.instructions),
      );
  const card = h(
    'main',
    { 'aria-labelledby': 'title' },
    h(
      'div',
      { className: 'orb', 'aria-hidden': 'true' },
      h('svg', { className: 'rc-icon', ...iconAttributes, dangerouslySetInnerHTML: { __html: iconPaths.mic } }),
    ),
    h('h1', { id: 'title', ...said('heading') }, text.heading),
    h('p', said('intro'), text.intro),
    control,
    h('div', { className: 'rc-lang' }),
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${text.title}</title>
<style>
${themeCss()}
  /* Voice card: a "night" panel of the shared theme. Layout only below. The content sets the height. */
  :root { --rc-body-size: 0.9375rem; --rc-focus: var(--rc-gold); }
  html { background: var(--rc-night); }
  body { color: var(--rc-on-night); background: linear-gradient(135deg, var(--rc-night), var(--rc-night-2)); text-align: center; }
  main { padding: 24px 20px; max-width: 38rem; margin: auto; }
  .orb { display: grid; place-items: center; width: 80px; height: 80px; border-radius: 50%; margin: 0 auto 16px;
    background: radial-gradient(circle at 35% 25%, #fff6c4, var(--rc-gold) 55%, #d9a93c);
    box-shadow: 0 0 28px color-mix(in srgb, var(--rc-gold) 45%, transparent); color: var(--rc-gold-ink); }
  .orb .rc-icon { width: 36px; height: 36px; }
  h1 { font-size: var(--rc-text-2xl); }
  p { margin: 8px auto 20px; max-width: 30rem; color: var(--rc-on-night-muted); }
  details > summary { display: inline-flex; color: var(--rc-gold-ink); }
  details > summary::before { display: none; }
  .help { margin: 12px auto 0; max-width: 25rem; font-size: var(--rc-text-sm); }
  .rc-lang { justify-content: center; margin-top: 12px; }
  .rc-lang:empty { display: none; }
  .rc-lang button { color: var(--rc-on-night-muted); }
  .rc-lang button[aria-pressed="true"] { color: var(--rc-on-night); }
  @media (hover: hover) { .rc-lang button:hover { background: color-mix(in srgb, var(--rc-on-night) 14%, transparent); color: var(--rc-on-night); } }
</style>
</head>
<body>
${renderToStaticMarkup(card)}
<script>${widgetScript()}</script>
</body>
</html>`;
}
