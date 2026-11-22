import type { ArtId } from './art.ts';

/**
 * Every raster image ReloCat uses, and the art direction to (re)generate it with
 * `npm run images:generate` (scripts/generate-images.ts). Until a file exists, the slot shows the
 * SVG of the same id from `art.ts`.
 *
 * Sizes follow the Images API rules for custom sizes: both edges divisible by 16, aspect ratio
 * between 1:3 and 3:1, at least 655,360 pixels in total.
 */
export type ImageSpec = {
  id: ArtId;
  /** Repository-relative path the generated file is written to and read from. */
  path: string;
  size: `${number}x${number}`;
  format: 'jpeg' | 'png' | 'webp';
  /** Where the image appears. */
  usedIn: string;
  /** Empty when the image is decoration next to text that already says the same thing. */
  alt: string;
  /** The scene; `imagePrompt` puts the shared style in front of it. */
  scene: string;
};

/**
 * One style for the whole family. The palette is the one in theme.css, named in words and in hex
 * so that every image sits on the same cream paper as the interface around it.
 */
export const imageStyle = [
  'Style: a warm, hand-made storybook illustration for a friendly housing guide to Catalonia.',
  'Flat gouache shapes with soft paper grain, gentle rounded forms, thin darker-green contour lines only where needed, no photorealism, no 3D render, no glossy gradients.',
  'Palette, strictly limited: cream paper background (#fbefdc), forest green (#17593d) and leaf green (#2f8f63), soft sage hills (#b9d6b0), violet (#663e91) for roofs and shadows, golden yellow (#f6c95c) for sun and light, a little terracotta (#d98a5f). Late-afternoon golden light from the upper right, long soft shadows.',
  'Setting details are Catalan and rural: stone and lime-washed houses with clay-tile roofs, a square church bell tower, cypress and holm oak, terraced fields, vineyards, a distant pre-Pyrenean ridge.',
  'When a character appears it is the ReloCat mascot: a small friendly house-shaped creature with a round leaf-green body, one lilac-violet pitched roof worn like a hat with a tiny chimney, two dot eyes, an open smile, pink cheeks and short dark-green arms and legs. Always the same character, always kind and calm.',
  'No text, no letters, no numbers, no logos, no flags, no borders, no frames, no watermarks. Leave the composition uncluttered.',
].join(' ');

export const images: ImageSpec[] = [
  {
    id: 'hero-valley',
    path: 'apps/mcp-server/assets/town-explorer.jpg',
    size: '1536x864',
    format: 'jpeg',
    usedIn: 'Homepage hero (/connect) and the header of the Town Explorer widget',
    alt: '',
    scene:
      'Scene: a wide view of a small Catalan town resting in a green valley. The town sits in the right two thirds: a cluster of twenty houses around a bell tower, a winding golden path leading to it from the lower centre, terraced fields and cypress around it, layered hills and a pale ridge behind, a low sun at the upper right. Two tiny ReloCat mascots walk the path towards the town, seen from a distance. The left third is almost empty cream sky fading to plain paper, because a headline is set over it. Horizon slightly above the middle. Wide 16:9 composition.',
  },
  {
    id: 'mascot-welcome',
    path: 'apps/mcp-server/assets/connect-welcome.jpg',
    size: '1024x1024',
    format: 'jpeg',
    usedIn: 'Homepage, beside "Get a feel for everyday life"',
    alt: '',
    scene:
      'Scene: the ReloCat mascot alone, full body, centred, standing on a small patch of grass and waving hello with one raised arm. Plain flat cream background (#fbefdc) with nothing else in it, soft contact shadow under the feet, generous empty margin on all sides. Square composition, spot illustration.',
  },
  {
    id: 'mascot-guide',
    path: 'apps/mcp-server/assets/connect-guide.jpg',
    size: '1024x1024',
    format: 'jpeg',
    usedIn: 'Homepage, beside "What would you ask?"',
    alt: '',
    scene:
      'Scene: the ReloCat mascot alone, full body, centred, holding an unfolded paper map with both hands and looking up from it with curiosity; the map shows a dotted violet route and one terracotta pin, no writing. Plain flat cream background (#fbefdc) with nothing else in it, soft contact shadow under the feet, generous empty margin on all sides. Square composition, spot illustration.',
  },
  {
    id: 'workspace-empty',
    path: 'apps/mcp-server/assets/workspace-empty.jpg',
    size: '1024x1024',
    format: 'jpeg',
    usedIn: 'Workspace widget, empty state before any place is compared',
    alt: '',
    scene:
      'Scene: the ReloCat mascot standing at a wooden signpost at a fork in a country path, looking up at two blank arrow-shaped signs that point to different directions, one cream and one golden; a soft sage hill behind and nothing else. Plain flat cream background (#fbefdc), generous empty margin. Square composition, spot illustration, calm and inviting.',
  },
  {
    id: 'og-card',
    path: 'apps/mcp-server/assets/og-card.jpg',
    size: '1200x624',
    format: 'jpeg',
    usedIn: 'Social sharing card of the homepage (og:image, served at /og.jpg)',
    alt: 'A small Catalan town in a green valley at golden hour, with the ReloCat mascot on the path.',
    scene:
      'Scene: a small Catalan town in a green valley at golden hour, filling the frame edge to edge: bell tower and clay roofs slightly right of centre, terraced fields, cypress, layered hills, low sun at the upper right. In the lower left foreground one ReloCat mascot stands on the path, seen from behind at three-quarter view, looking towards the town. Balanced so the image still reads when cropped to a square from the centre. Wide 1.91:1 composition.',
  },
];

/** The full prompt sent to the Images API for one image. */
export const imagePrompt = (spec: ImageSpec) => `${imageStyle}\n\n${spec.scene}`;
