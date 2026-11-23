import { socrata } from '../packages/sources/http.ts';

/**
 * The two downloads that settle which municipalities exist, their names and their centres. They
 * only run in a full `data:refresh`: the live layer never changes the municipality list. Every
 * other download is a source definition in `packages/sources/definitions/`.
 */
export const urls = {
  emexNodes: 'https://api.idescat.cat/emex/v1/nodes.json?lang=ca',
  geography: `${socrata}/d/wpyq-we8x`,
};
