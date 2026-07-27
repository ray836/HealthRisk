/**
 * Convert Natural Earth 1:110m GeoJSON into the static SVG paths used by the
 * game board.
 *
 * Usage:
 *   node scripts/generate-world-map.mjs countries.geojson land.geojson public/world-map-data.js
 *
 * Source data:
 * https://github.com/nvkelso/natural-earth-vector
 * Natural Earth vector data is public domain.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , countriesFile, landFile, outputFile] = process.argv;
if (!countriesFile || !landFile || !outputFile) {
  throw new Error('Expected countries GeoJSON, land GeoJSON, and output file arguments');
}

const countries = JSON.parse(await readFile(countriesFile, 'utf8'));
const land = JSON.parse(await readFile(landFile, 'utf8'));

const VIEWBOX = { width: 980, height: 545 };
const BOUNDS = { west: -180, east: 180, north: 82, south: -58 };
const PADDING = { x: 18, y: 14 };
const drawableWidth = VIEWBOX.width - PADDING.x * 2;
const drawableHeight = VIEWBOX.height - PADDING.y * 2;

function project([longitude, latitude]) {
  const x = PADDING.x + ((longitude - BOUNDS.west) / (BOUNDS.east - BOUNDS.west)) * drawableWidth;
  const y = PADDING.y + ((BOUNDS.north - latitude) / (BOUNDS.north - BOUNDS.south)) * drawableHeight;
  return [Number(x.toFixed(1)), Number(y.toFixed(1))];
}

function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function maxLatitude(polygon) {
  return Math.max(...polygon.flat().map(([, latitude]) => latitude));
}

function clipRingAtLongitude(ring, longitude, keepWest) {
  if (ring.length < 3) return [];
  const source = ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]
    ? ring.slice(0, -1)
    : ring;
  const clipped = [];
  const inside = ([x]) => keepWest ? x <= longitude : x >= longitude;
  const intersection = (from, to) => {
    const distance = to[0] - from[0];
    const ratio = distance === 0 ? 0 : (longitude - from[0]) / distance;
    return [longitude, from[1] + (to[1] - from[1]) * ratio];
  };

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const previous = source[(index + source.length - 1) % source.length];
    const currentInside = inside(current);
    const previousInside = inside(previous);
    if (currentInside) {
      if (!previousInside) clipped.push(intersection(previous, current));
      clipped.push(current);
    } else if (previousInside) {
      clipped.push(intersection(previous, current));
    }
  }
  if (clipped.length >= 3) clipped.push(clipped[0]);
  return clipped;
}

function clipPolygonAtLongitude(polygon, longitude, keepWest) {
  return polygon
    .map((ring) => clipRingAtLongitude(ring, longitude, keepWest))
    .filter((ring) => ring.length >= 4);
}

function ringPath(ring) {
  if (ring.length < 4) return '';
  const points = ring.map(project);
  return `M${points.map(([x, y]) => `${x},${y}`).join('L')}Z`;
}

function polygonPath(polygon) {
  return polygon.map(ringPath).join('');
}

const REGION_BY_CONTINENT = {
  'North America': 'north_america',
  'South America': 'south_america',
  Europe: 'europe',
  Africa: 'africa',
  Asia: 'asia',
  Oceania: 'australia',
};
const regionPolygons = Object.fromEntries(
  ['north_america', 'south_america', 'europe', 'africa', 'asia', 'australia']
    .map((region) => [region, []]),
);

for (const feature of countries.features) {
  const name = feature.properties?.NAME;
  const continent = feature.properties?.CONTINENT;
  if (continent === 'Antarctica' || continent === 'Seven seas (open ocean)') continue;
  const polygons = polygonsOf(feature.geometry);

  if (name === 'Russia') {
    for (const polygon of polygons) {
      const european = clipPolygonAtLongitude(polygon, 60, true);
      const asian = clipPolygonAtLongitude(polygon, 60, false);
      if (european.length) regionPolygons.europe.push(european);
      if (asian.length) regionPolygons.asia.push(asian);
    }
    continue;
  }

  const region = name === 'Indonesia' ? 'australia' : REGION_BY_CONTINENT[continent];
  if (!region) continue;
  regionPolygons[region].push(...polygons);
}

const coastlinePolygons = land.features
  .flatMap((feature) => polygonsOf(feature.geometry))
  .filter((polygon) => maxLatitude(polygon) > BOUNDS.south);

const regionPaths = Object.fromEntries(
  Object.entries(regionPolygons).map(([region, polygons]) => [
    region,
    polygons.map(polygonPath).join(''),
  ]),
);
const coastlinePath = coastlinePolygons.map(polygonPath).join('');

const output = `/**
 * Generated from Natural Earth 1:110m public-domain vector data.
 * Source: https://github.com/nvkelso/natural-earth-vector
 * Regenerate with scripts/generate-world-map.mjs.
 */
globalThis.WORLD_MAP_DATA = ${JSON.stringify({
  viewBox: VIEWBOX,
  bounds: BOUNDS,
  regions: regionPaths,
  coastline: coastlinePath,
})};
`;

await writeFile(outputFile, output, 'utf8');
console.log(`Generated ${path.relative(process.cwd(), outputFile)} (${output.length.toLocaleString()} bytes)`);
