/**
 * Standard 42-territory Risk board: 6 continents, canonical adjacency.
 *
 * Adjacency is declared once per edge in ADJACENCY and expanded into a
 * symmetric lookup at module load. `assertSymmetric()` (exercised by the tests)
 * guarantees we never ship a one-directional edge.
 */

import type { ContinentId, TerritoryId } from './types.js';

export interface ContinentDef {
  id: ContinentId;
  label: string;
  bonus: number; // reference value; not used for reinforcement in this game
  territories: TerritoryId[];
}

export const CONTINENTS: ContinentDef[] = [
  {
    id: 'north_america',
    label: 'North America',
    bonus: 5,
    territories: [
      'alaska', 'northwest_territory', 'greenland', 'alberta', 'ontario',
      'quebec', 'western_us', 'eastern_us', 'central_america',
    ],
  },
  {
    id: 'south_america',
    label: 'South America',
    bonus: 2,
    territories: ['venezuela', 'peru', 'brazil', 'argentina'],
  },
  {
    id: 'europe',
    label: 'Europe',
    bonus: 5,
    territories: [
      'iceland', 'great_britain', 'scandinavia', 'northern_europe',
      'western_europe', 'southern_europe', 'ukraine',
    ],
  },
  {
    id: 'africa',
    label: 'Africa',
    bonus: 3,
    territories: [
      'north_africa', 'egypt', 'east_africa', 'congo', 'south_africa', 'madagascar',
    ],
  },
  {
    id: 'asia',
    label: 'Asia',
    bonus: 7,
    territories: [
      'ural', 'siberia', 'yakutsk', 'kamchatka', 'irkutsk', 'mongolia', 'japan',
      'afghanistan', 'china', 'middle_east', 'india', 'siam',
    ],
  },
  {
    id: 'australia',
    label: 'Australia',
    bonus: 2,
    territories: ['indonesia', 'new_guinea', 'western_australia', 'eastern_australia'],
  },
];

export const TERRITORY_IDS: TerritoryId[] = CONTINENTS.flatMap((c) => c.territories);

export const CONTINENT_OF: Record<TerritoryId, ContinentId> = Object.fromEntries(
  CONTINENTS.flatMap((c) => c.territories.map((t) => [t, c.id] as const)),
);

/**
 * Canonical Risk edges. Each undirected edge listed exactly once; the reverse
 * direction is generated below.
 */
const ADJACENCY: Array<[TerritoryId, TerritoryId]> = [
  // North America (internal)
  ['alaska', 'northwest_territory'],
  ['alaska', 'alberta'],
  ['northwest_territory', 'alberta'],
  ['northwest_territory', 'ontario'],
  ['northwest_territory', 'greenland'],
  ['greenland', 'ontario'],
  ['greenland', 'quebec'],
  ['alberta', 'ontario'],
  ['alberta', 'western_us'],
  ['ontario', 'quebec'],
  ['ontario', 'western_us'],
  ['ontario', 'eastern_us'],
  ['quebec', 'eastern_us'],
  ['western_us', 'eastern_us'],
  ['western_us', 'central_america'],
  ['eastern_us', 'central_america'],
  // NA <-> SA / Europe / Asia
  ['central_america', 'venezuela'],
  ['alaska', 'kamchatka'],
  ['greenland', 'iceland'],
  // South America (internal)
  ['venezuela', 'peru'],
  ['venezuela', 'brazil'],
  ['peru', 'brazil'],
  ['peru', 'argentina'],
  ['brazil', 'argentina'],
  // SA <-> Africa
  ['brazil', 'north_africa'],
  // Europe (internal)
  ['iceland', 'great_britain'],
  ['iceland', 'scandinavia'],
  ['great_britain', 'scandinavia'],
  ['great_britain', 'northern_europe'],
  ['great_britain', 'western_europe'],
  ['scandinavia', 'northern_europe'],
  ['scandinavia', 'ukraine'],
  ['northern_europe', 'western_europe'],
  ['northern_europe', 'southern_europe'],
  ['northern_europe', 'ukraine'],
  ['western_europe', 'southern_europe'],
  ['southern_europe', 'ukraine'],
  // Europe <-> Africa / Asia
  ['western_europe', 'north_africa'],
  ['southern_europe', 'north_africa'],
  ['southern_europe', 'egypt'],
  ['southern_europe', 'middle_east'],
  ['ukraine', 'ural'],
  ['ukraine', 'afghanistan'],
  ['ukraine', 'middle_east'],
  // Africa (internal)
  ['north_africa', 'egypt'],
  ['north_africa', 'east_africa'],
  ['north_africa', 'congo'],
  ['egypt', 'east_africa'],
  ['east_africa', 'congo'],
  ['east_africa', 'south_africa'],
  ['east_africa', 'madagascar'],
  ['congo', 'south_africa'],
  ['south_africa', 'madagascar'],
  // Africa <-> Asia
  ['egypt', 'middle_east'],
  ['east_africa', 'middle_east'],
  // Asia (internal)
  ['ural', 'siberia'],
  ['ural', 'china'],
  ['ural', 'afghanistan'],
  ['siberia', 'yakutsk'],
  ['siberia', 'irkutsk'],
  ['siberia', 'mongolia'],
  ['siberia', 'china'],
  ['yakutsk', 'irkutsk'],
  ['yakutsk', 'kamchatka'],
  ['kamchatka', 'irkutsk'],
  ['kamchatka', 'mongolia'],
  ['kamchatka', 'japan'],
  ['irkutsk', 'mongolia'],
  ['mongolia', 'japan'],
  ['mongolia', 'china'],
  ['afghanistan', 'china'],
  ['afghanistan', 'india'],
  ['afghanistan', 'middle_east'],
  ['china', 'india'],
  ['china', 'siam'],
  ['middle_east', 'india'],
  ['india', 'siam'],
  // Asia <-> Australia
  ['siam', 'indonesia'],
  // Australia (internal)
  ['indonesia', 'new_guinea'],
  ['indonesia', 'western_australia'],
  ['new_guinea', 'western_australia'],
  ['new_guinea', 'eastern_australia'],
  ['western_australia', 'eastern_australia'],
];

const neighbors: Record<TerritoryId, Set<TerritoryId>> = Object.fromEntries(
  TERRITORY_IDS.map((t) => [t, new Set<TerritoryId>()]),
);
for (const [a, b] of ADJACENCY) {
  neighbors[a]!.add(b);
  neighbors[b]!.add(a);
}

export const NEIGHBORS: Record<TerritoryId, TerritoryId[]> = Object.fromEntries(
  TERRITORY_IDS.map((t) => [t, [...neighbors[t]!].sort()]),
);

export function areAdjacent(a: TerritoryId, b: TerritoryId): boolean {
  return neighbors[a]?.has(b) ?? false;
}

export function isValidTerritory(id: string): id is TerritoryId {
  return id in neighbors;
}

/**
 * Standard Risk starting armies for player counts 2–6, extended to 7–10.
 *
 * Standard totals plateau around ~120 armies on the board (4p:120, 5p:125,
 * 6p:120). We keep that ceiling for 7–10 by dividing ~120 across players, so
 * per-player armies fall as territories-per-player fall. Tunable — see
 * DECISIONS.md, open item #1/#4.
 */
export function startingArmies(playerCount: number): number {
  const table: Record<number, number> = { 2: 40, 3: 35, 4: 30, 5: 25, 6: 20 };
  if (playerCount in table) return table[playerCount]!;
  if (playerCount >= 7 && playerCount <= 10) return Math.floor(120 / playerCount);
  throw new Error(`Unsupported player count: ${playerCount}`);
}

/** Throws if any edge is one-directional. Used by tests as a data guard. */
export function assertSymmetric(): void {
  for (const t of TERRITORY_IDS) {
    for (const n of NEIGHBORS[t]!) {
      if (!areAdjacent(n, t)) {
        throw new Error(`Asymmetric adjacency: ${t} -> ${n} but not reverse`);
      }
    }
  }
}
