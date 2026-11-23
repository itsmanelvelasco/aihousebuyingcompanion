import { App } from '@modelcontextprotocol/ext-apps';
import { browserLocale } from '../../packages/i18n/browser.ts';
import { translator } from '../../packages/i18n/messages.ts';
import { cashFlow } from './cash-flow.messages.ts';
import { cashFlowView } from './cash-flow-view.ts';
import { applyMessages, mountLanguages } from './widget-i18n.ts';

/**
 * The script of the sample cash-flow card. `App` does the host handshake and reports the size of
 * the document, the same way the other widgets do; the card shows the result of `sample_cash_flow`.
 */
const app = window.parent !== window ? new App({ name: 'ReloCat cash flow', version: '1.0.0' }) : null;
const requestOptions = { timeout: 15_000 };
const byId = (id: string) => document.getElementById(id)!;

let summary: unknown = null;
let failed = false;
let hostLocale: string | undefined;

const markLanguage = mountLanguages(byId('languages'), () => render());

function rows(id: string, entries: [string, string][]) {
  byId(id).replaceChildren(
    ...entries.map(([label, value]) => {
      const row = document.createElement('div');
      const name = document.createElement('dt');
      const figure = document.createElement('dd');
      name.textContent = label;
      figure.textContent = value;
      row.append(name, figure);
      return row;
    }),
  );
}

function render() {
  // The address, a choice made here or before, the host, the browser: `browserLocale` decides.
  const locale = browserLocale(hostLocale);
  const view = cashFlowView(summary, locale, failed);
  document.documentElement.lang = locale;
  document.title = view.title;
  applyMessages(document, translator(cashFlow, locale));
  markLanguage(locale);
  byId('coverage').textContent = view.coverage;
  if (!view.totals) return;
  rows('totals', view.totals);
  rows('expenses', view.expenses);
  byId('breakdown').hidden = false;
}
render();

if (app) {
  app.ontoolresult = result => {
    summary = result.structuredContent ?? summary;
    render();
  };
  app.onhostcontextchanged = context => {
    if (!context.locale) return;
    hostLocale = context.locale;
    render();
  };
  void app
    .connect(undefined, requestOptions)
    .then(() => {
      hostLocale = app.getHostContext()?.locale ?? hostLocale;
    })
    .catch(() => {
      failed = true;
    })
    .finally(render);
}
