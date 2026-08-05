import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

await import('../public/world-map-data.js');

const map = globalThis.WORLD_MAP_DATA;
if (!map?.coastline || !map?.regions) {
  throw new Error('public/world-map-data.js did not expose the expected map data.');
}

const continentColors = {
  north_america: '#5a9bd5',
  south_america: '#55b58f',
  europe: '#9a83d3',
  africa: '#d49a52',
  asia: '#d16f83',
  australia: '#55aaa8',
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(
  root,
  'ios/HealthRisk/Resources/Assets.xcassets/WorldMap.imageset',
);

const regionPaths = Object.entries(continentColors)
  .map(([id, color]) => {
    const vectorPath = map.regions[id];
    if (!vectorPath) throw new Error(`Missing world-map region: ${id}`);
    return `  <path d="${vectorPath}" fill="${color}" fill-opacity="0.30" fill-rule="evenodd"/>`;
  })
  .join('\n');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${map.viewBox.width}" height="${map.viewBox.height}" viewBox="0 0 ${map.viewBox.width} ${map.viewBox.height}">
  <path d="${map.coastline}" fill="#17212c" fill-rule="evenodd"/>
${regionPaths}
  <path d="${map.coastline}" fill="none" stroke="#758699" stroke-width="1.15" stroke-opacity="0.82" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

const contents = {
  images: [
    {
      filename: 'WorldMap.svg',
      idiom: 'universal',
      scale: '1x',
    },
    { idiom: 'universal', scale: '2x' },
    { idiom: 'universal', scale: '3x' },
  ],
  info: {
    author: 'xcode',
    version: 1,
  },
  properties: {
    'preserves-vector-representation': true,
  },
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(path.join(outputDirectory, 'WorldMap.svg'), svg),
  writeFile(
    path.join(outputDirectory, 'Contents.json'),
    `${JSON.stringify(contents, null, 2)}\n`,
  ),
]);

console.log(`Generated ${path.relative(root, outputDirectory)}`);
