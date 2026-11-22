/** One name for the product everywhere: `ReloCat` in text people read, `relocat` in identifiers. */
export const product = {
  name: 'ReloCat',
  id: 'relocat',
  version: '0.2.0',
  site: 'https://www.relo.cat',
} as const;

/** MCP App resource URI for a bundled widget, for example `ui://relocat/town-explorer-v1.html`. */
export const widgetUri = (file: string) => `ui://${product.id}/${file}`;
