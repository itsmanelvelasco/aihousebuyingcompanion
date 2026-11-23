import { build } from 'esbuild';

/** Browser bundles served by the Node services. Outputs are ignored by Git and rebuilt on demand. */
const bundles = [
  {
    entryPoints: ['apps/mcp-server/town-explorer-widget.ts'],
    outfile: 'apps/mcp-server/dist/town-explorer.js',
    minify: true,
    legalComments: 'eof' as const,
  },
  {
    entryPoints: ['apps/mcp-server/voice-card-widget.ts'],
    outfile: 'apps/mcp-server/dist/voice-card.js',
    minify: true,
    legalComments: 'eof' as const,
  },
  { entryPoints: ['apps/board/widget.ts'], outfile: 'apps/board/dist/widget.js' },
  { entryPoints: ['apps/interviewer/app.ts'], outfile: 'apps/interviewer/dist/app.js' },
  {
    entryPoints: ['apps/web/main.tsx'],
    outfile: 'apps/web/dist/workspace.js',
    minify: true,
    legalComments: 'eof' as const,
    jsx: 'automatic' as const,
    define: { 'process.env.NODE_ENV': '"production"' },
  },
];

await Promise.all(
  bundles.map(bundle => build({ bundle: true, format: 'iife', target: 'es2022', logLevel: 'warning', ...bundle })),
);
console.log(`Built ${bundles.length} browser bundles.`);
