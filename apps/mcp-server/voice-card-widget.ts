import { App } from '@modelcontextprotocol/ext-apps';
import { browserLocale } from '../../packages/i18n/browser.ts';
import type { Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import { voiceCard } from './voice-card.messages.ts';
import { applyMessages, mountLanguages } from './widget-i18n.ts';

/**
 * The script of the "Start talking" card. `App` does the host handshake and reports the size of
 * the document as it changes, the same way the Town Explorer and the board do.
 */
const app = window.parent !== window ? new App({ name: 'ReloCat Start talking', version: '1.0.0' }) : null;
const requestOptions = { timeout: 15_000 };

// A language picked on the card wins over what the host states for as long as the card is shown.
let chosen = false;
const markLanguage = mountLanguages(document.querySelector<HTMLElement>('.rc-lang')!, locale => {
  chosen = true;
  show(locale);
});
function show(locale: Locale) {
  const t = translator(voiceCard, locale);
  document.documentElement.lang = locale;
  document.title = t('title');
  applyMessages(document, t);
  markLanguage(locale);
}
show(browserLocale());

type OpenAiHost = {
  openExternal?: (target: { href: string; redirectUrl: boolean }) => unknown;
  sendFollowUpMessage?: (message: { prompt: string }) => unknown;
};
const openai = () => (window as { openai?: OpenAiHost }).openai;

/**
 * "Start the interview here": the opening message goes into the chat the card is shown in, as the
 * person's own message, so the interview continues there by text or with the host's voice mode.
 * A host that offers no way to send it gets the sentence to say or type instead.
 */
document.querySelector<HTMLButtonElement>('.start-here')?.addEventListener('click', async event => {
  const button = event.currentTarget as HTMLButtonElement;
  const reveal = (id: string) => {
    document.querySelector<HTMLElement>('#start-sent')!.hidden = id !== 'start-sent';
    document.querySelector<HTMLElement>('#start-help')!.hidden = id !== 'start-help';
  };
  const text = translator(voiceCard, (document.documentElement.lang as Locale) || 'en')('startMessage');
  button.setAttribute('aria-busy', 'true');
  try {
    const host = openai();
    if (typeof host?.sendFollowUpMessage === 'function') await host.sendFollowUpMessage({ prompt: text });
    else if (app) {
      const sent = await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] }, requestOptions);
      if (sent.isError) throw new Error('The host refused the message');
    } else throw new Error('No host');
    reveal('start-sent');
    button.disabled = true;
  } catch {
    reveal('start-help');
  } finally {
    button.removeAttribute('aria-busy');
  }
});

document.querySelector<HTMLAnchorElement>('.launch')?.addEventListener('click', event => {
  const link = event.currentTarget as HTMLAnchorElement;
  const showHelp = () => {
    document.querySelector<HTMLElement>('#start-help')!.hidden = false;
  };
  const host = openai();
  if (typeof host?.openExternal === 'function') {
    event.preventDefault();
    try {
      Promise.resolve(host.openExternal({ href: link.href, redirectUrl: false })).catch(showHelp);
    } catch {
      showHelp();
    }
  } else if (app?.getHostCapabilities()?.openLinks) {
    event.preventDefault();
    void app
      .openLink({ url: link.href }, requestOptions)
      .then(response => {
        if (response.isError) showHelp();
      })
      .catch(showHelp);
  }
});

if (app) {
  // The host's language applies unless the person chose one here or the address states one.
  app.onhostcontextchanged = context => {
    if (context.locale && !chosen) show(browserLocale(context.locale));
  };
  void app
    .connect(undefined, requestOptions)
    .then(() => {
      if (!chosen) show(browserLocale(app.getHostContext()?.locale));
    })
    .catch(() => {
      // Without a host the card still shows its text and its link.
    });
}
