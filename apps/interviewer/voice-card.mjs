import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export function renderVoiceCard(launchUrl, script) {
  const instructions = 'Select the Voice icon in ChatGPT, then say “Use Relocat Team to start my homebuying interview.”';
  const control = launchUrl
    ? h('div', null,
      h('a', { className: 'action launch', href: launchUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Start talking'),
      h('p', { className: 'help' }, 'Opens the Relocat voice interviewer.'),
      h('p', { id: 'launch-help', className: 'help', hidden: true, role: 'status' }, instructions))
    : h('details', null,
      h('summary', { className: 'action' }, 'Start talking'),
      h('p', { className: 'help' }, instructions));
  const card = h('main', { 'aria-labelledby': 'title' },
    h('div', { className: 'orb', 'aria-hidden': 'true' },
      h('span', { className: 'wave' }, '▂ ▅ █ ▅ ▂')),
    h('h1', { id: 'title' }, 'Your homebuying interview'),
    h('p', null, 'Start with your bank transactions and talk through your home goals.'),
    control);
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relocat homebuying interview</title>
<style>
  :root { color-scheme: light dark; font: 15px/1.5 system-ui,sans-serif; }
  body { margin:0; color:#f3f8ed; background:#10251b; text-align:center; }
  main { padding:24px 18px; max-width:38rem; margin:auto; }
  .orb { display:grid; place-items:center; width:84px; height:84px; border-radius:50%; margin:2px auto 16px;
    background:radial-gradient(circle at 35% 22%,#e8f4a8,#6aa669 48%,#214b36 82%);
    box-shadow:0 0 26px #7ca85d66; }
  .wave { color:#ffffe4; font-size:13px; }
  h1 { margin:0 0 4px; font:500 1.6rem Georgia,serif; }
  p { margin:0 auto 16px; color:#c9dccb; }
  .action { display:inline-block; background:#e1efbf; color:#18291e; border-radius:100px;
    padding:8px 17px; font-weight:650; cursor:pointer; text-decoration:none; }
  .action:focus-visible { outline:2px solid #f5f9eb; outline-offset:3px; }
  summary { list-style:none; }
  summary::-webkit-details-marker { display:none; }
  .help { margin:10px auto 0; max-width:25rem; font-size:.87rem; }
  [hidden] { display:none !important; }
</style>
${renderToStaticMarkup(card)}
<script>${script.replace(/<\/script/gi, '<\\/script')}</script>
</html>`;
}
