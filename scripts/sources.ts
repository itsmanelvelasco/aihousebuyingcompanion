import { lleidaCode } from '../packages/sources/definitions/fgc-gtfs.ts';
import { socrata } from '../packages/sources/http.ts';

export { lleidaCode };

/**
 * The two downloads that settle which municipalities exist, their names and their centres. They
 * only run in a full `data:refresh`: the live layer never changes the municipality list. Every
 * other download is a source definition in `packages/sources/definitions/`.
 */
export const urls = {
  emexNodes: 'https://api.idescat.cat/emex/v1/nodes.json?lang=ca',
  geography: `${socrata}/d/wpyq-we8x`,
};

// The demo includes the RL1/RL2 corridor and selected municipalities elsewhere in Catalonia.
// Lleida serves as a transport destination.
export const recommendableCodes = [
  '080312',
  '250024',
  '250122',
  '250371',
  '250404',
  '250621',
  '251180',
  '251569',
  '251713',
  '251902',
  '252154',
  '252206',
  '252347',
  '252402',
  '252542',
  '259046',
  '431573',
];
