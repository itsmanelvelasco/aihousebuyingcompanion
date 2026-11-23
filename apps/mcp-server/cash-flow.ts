import { readFileSync } from 'node:fs';
import { inlineUi } from '../../packages/ui/inline.ts';

/**
 * The sample cash-flow card as one document: the template, the shared theme and the bundled script
 * (`cash-flow-widget.ts`, built by `npm run build`). Like the other widgets it has one way to
 * reach its host: without the bundle there is no card, and reading it says how to build one.
 */
export function loadCashFlowCard() {
  let bundle: string;
  try {
    bundle = readFileSync(new URL('./dist/cash-flow.js', import.meta.url), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error('The cash-flow card has not been built. Run `npm run build`.');
  }
  return inlineUi(readFileSync(new URL('./cash-flow-widget.html', import.meta.url), 'utf8')).replace(
    '<!-- WIDGET -->',
    () => `<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`,
  );
}
