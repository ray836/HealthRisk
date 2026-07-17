/**
 * Manual playground — drive a real Exercise Risk turn end-to-end with no UI,
 * no database, and no API key. Run with:  npx tsx scripts/playground.ts
 *
 * It sets up a 2-player game, banks some "earned" troops, opens the daily
 * session, and takes player A's turn through the interactive TurnApi, printing
 * the board and combat results as it goes.
 */

import { InMemoryGameRepository } from '../src/services/repository.js';
import { TurnApi } from '../src/services/turnApi.js';
import { openDailySession, markTurnComplete } from '../src/services/orchestrator.js';
import { createGame } from '../src/engine/setup.js';
import { grantDailyReinforcements } from '../src/engine/game.js';
import { earnedTroops } from '../src/engine/reinforce.js';
import type { GameConfig, GameState } from '../src/engine/types.js';

const config: GameConfig = {
  exercises: [
    { key: 'running', label: 'Running', unitLabel: 'mile', troopsPerUnit: 1, dailyUnitCap: 3 },
    { key: 'lifting', label: 'Weightlifting', unitLabel: 'min', troopsPerUnit: 1 / 30, dailyUnitCap: 60 },
  ],
  dailyTotalTroopCap: 5,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/New_York',
};

function ownedBy(g: GameState, playerId: string) {
  return g.territories
    .filter((t) => t.owner === playerId)
    .map((t) => `${t.id}(${t.armies})`)
    .join(', ');
}

async function main() {
  // Two players; deterministic board so the demo is repeatable.
  let game = createGame({
    id: 'g',
    config,
    players: [
      { id: 'a', name: 'Alice' },
      { id: 'b', name: 'Bob' },
    ],
    seed: 5,
  });
  game = {
    ...game,
    turnOrder: ['a', 'b'],
    dayNumber: 1,
    territories: game.territories.map((t) => ({
      ...t,
      owner: t.id === 'venezuela' ? 'a' : t.id === 'brazil' || t.id === 'peru' ? 'b' : t.owner,
      armies: t.id === 'venezuela' ? 8 : t.id === 'brazil' || t.id === 'peru' ? 1 : t.armies,
    })),
  };

  const repo = new InMemoryGameRepository({ games: [game] });

  // Alice "logs exercise" — 3 miles run + 30 min lifting -> banked troops.
  const earned = earnedTroops(config, [
    { exerciseKey: 'running', units: 3 },
    { exerciseKey: 'lifting', units: 30 },
  ]);
  console.log(`Alice earned ${earned.total} troops from exercise (${JSON.stringify(earned.perExercise)})`);
  await repo.saveGame(grantDailyReinforcements((await repo.loadGame('g'))!, 'a', [
    { exerciseKey: 'running', units: 3 },
    { exerciseKey: 'lifting', units: 30 },
  ]));

  await openDailySession(repo, 'g', 1);
  const api = new TurnApi({ repo, onPlayerCompleted: (gid, d, p) => markTurnComplete(repo, gid, d, p) });

  const view = await api.turnView('g', 1)!;
  console.log(`\nUp now: ${view!.playerId} | phase ${view!.phase} | bank ${view!.context.pendingReinforcements}`);
  console.log('Alice owns:', ownedBy((await repo.loadGame('g'))!, 'a'));

  // Reinforce Venezuela with the whole bank.
  const r = await api.placeReinforcements('g', 1, 'a', [
    { territoryId: 'venezuela', count: view!.context.pendingReinforcements },
  ]);
  console.log(`\nReinforced venezuela; bank now ${r.remainingBank}`);

  // Attack Brazil from Venezuela.
  const result = await api.attack('g', 1, 'a', {
    fromId: 'venezuela',
    toId: 'brazil',
    committedTroops: 9,
    stopLoss: 100,
  });
  console.log(`\nAttack venezuela -> brazil: ${result.endReason}, captured=${result.captured}`);
  console.log(`  attacker losses ${result.totalAttackerLosses}, defender losses ${result.totalDefenderLosses}, ${result.rounds.length} rounds`);

  await api.endTurn('g', 1, 'a');
  const final = (await repo.loadGame('g'))!;
  console.log('\nAfter Alice\'s turn:');
  console.log('  Alice owns:', ownedBy(final, 'a'));
  console.log('  Bob owns:', ownedBy(final, 'b'));
  console.log('  Up next:', (await api.turnView('g', 1))?.playerId ?? '(none)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
