/**
 * Proves on-disk persistence across process restarts.
 *   npx tsx scripts/persistCheck.ts save   # process 1: writes a game to disk
 *   npx tsx scripts/persistCheck.ts load   # process 2: reads it back
 */
import { createDb } from '../db/client.js';
import { DrizzleGameRepository } from '../src/services/drizzleRepository.js';
import { createGame } from '../src/engine/setup.js';
import type { GameConfig } from '../src/engine/types.js';

const DIR = '/tmp/exrisk-persist-check';
const config = { exercises: [], dailyTotalTroopCap: 5, windowStartMinuteOfDay: 1140, perPlayerWindowMinutes: 20, autoForfeitAfterDays: null, autoAttackStopLoss: 3, maxAttacksPerTurn: null, timezone: 'America/New_York' } as GameConfig;

async function main() {
  const mode = process.argv[2];
  const { db, close } = await createDb({ dir: DIR });
  const repo = new DrizzleGameRepository(db);

  if (mode === 'save') {
    const g = createGame({ id: 'persist-test', config, players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 42 });
    await repo.saveGame({ ...g, dayNumber: 5 });
    console.log('SAVED game persist-test (day 5,', g.territories.length, 'territories)');
  } else {
    const g = await repo.loadGame('persist-test');
    if (!g) console.log('LOAD: not found ❌');
    else console.log('LOADED game', g.id, '— day', g.dayNumber, ',', g.territories.length, 'territories, status', g.status, '✅');
  }
  await close();
}
main().catch((e) => { console.error(e); process.exit(1); });
