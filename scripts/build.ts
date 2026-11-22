import { build } from 'esbuild';

/** Browser bundles served by the Node services. Outputs are ignored by Git and rebuilt on demand. */
const bundles = [
  {
    entryPoints: ['apps/mcp-server/town-explorer-widget.ts'],
    outfile: 'apps/mcp-server/dist/town-explorer.js',
    minify: true,
    legalComments: 'eof' as const,
    loader: { '.jpg': 'dataurl' as const },
  },
  { entryPoints: ['apps/board/widget.ts'], outfile: 'apps/board/dist/widget.js' },
  { entryPoints: ['apps/interviewer/app.mjs'], outfile: 'apps/interviewer/dist/app.js' },
];

await Promise.all(
  bundles.map(bundle => build({ bundle: true, format: 'iife', target: 'es2022', logLevel: 'warning', ...bundle })),
);
console.log(`Built ${bundles.length} browser bundles.`);
