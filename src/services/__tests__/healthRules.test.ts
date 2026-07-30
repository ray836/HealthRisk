import { describe, expect, it } from 'vitest';

import type { GameState } from '../../engine/types.js';
import {
  applyApprovedHealthRules,
  normalizeHealthRules,
  proposeHealthRules,
  voteOnHealthRules,
} from '../healthRules.js';
import { InMemoryGameRepository } from '../repository.js';

const game: GameState = {
  id: 'health-game',
  config: {
    exercises: [
      { key: 'run', label: 'Run', unitLabel: 'mile', category: 'movement', troopsPerUnit: 1, dailyUnitCap: 5 },
    ],
    categoryTroopCaps: { movement: 5 },
    healthRuleGovernance: 'vote',
    dailyTotalTroopCap: 5,
    windowStartMinuteOfDay: 19 * 60,
    perPlayerWindowMinutes: 20,
    autoForfeitAfterDays: null,
    autoAttackStopLoss: 3,
    maxAttacksPerTurn: null,
    timezone: 'America/Los_Angeles',
  },
  players: ['p1', 'p2', 'p3'].map((id) => ({
    id,
    name: id,
    status: 'active',
    pendingReinforcements: 0,
    consecutiveAutoResolvedDays: 0,
    standingOrdersNote: '',
  })),
  territories: [],
  turnOrder: ['p1', 'p2', 'p3'],
  dayNumber: 2,
  status: 'active',
  healthRulesVersion: 1,
};

const proposedRules = {
  exercises: [
    {
      key: 'vegetables',
      label: 'Vegetable goal',
      unitLabel: 'anything',
      category: 'nutrition' as const,
      trackingType: 'checkbox' as const,
      troopsPerUnit: 1,
      dailyUnitCap: 99,
    },
  ],
  categoryTroopCaps: { nutrition: 2 },
  dailyTotalTroopCap: 6,
};

describe('health rule configuration', () => {
  it('normalizes checkbox goals to one completion per day', () => {
    const normalized = normalizeHealthRules(proposedRules);
    expect(normalized.exercises[0]).toMatchObject({
      key: 'vegetables',
      unitLabel: 'completion',
      dailyUnitCap: 1,
    });
  });

  it('requires a majority and schedules approved changes for the next day', async () => {
    const repo = new InMemoryGameRepository({ games: [game] });
    await proposeHealthRules(repo, game.id, 'p1', proposedRules);
    let saved = (await repo.loadGame(game.id))!;
    expect(saved.pendingHealthRuleProposal?.status).toBe('pending');

    await voteOnHealthRules(repo, game.id, 'p2', true);
    saved = (await repo.loadGame(game.id))!;
    expect(saved.pendingHealthRuleProposal).toMatchObject({
      status: 'approved',
      effectiveDay: 3,
    });
  });

  it('does not apply approved changes partway through the current day', async () => {
    const repo = new InMemoryGameRepository({ games: [game] });
    await proposeHealthRules(repo, game.id, 'p1', proposedRules);
    await voteOnHealthRules(repo, game.id, 'p2', true);
    const approved = (await repo.loadGame(game.id))!;

    expect(applyApprovedHealthRules(approved, 2).config.exercises[0]?.key).toBe('run');
    const applied = applyApprovedHealthRules(approved, 3);
    expect(applied.config.exercises[0]?.key).toBe('vegetables');
    expect(applied.healthRulesVersion).toBe(2);
    expect(applied.pendingHealthRuleProposal).toBeUndefined();
  });

  it('lets creator-managed games schedule a change without a vote', async () => {
    const creatorGame: GameState = {
      ...game,
      config: { ...game.config, healthRuleGovernance: 'creator' },
    };
    const repo = new InMemoryGameRepository({ games: [creatorGame] });
    await proposeHealthRules(repo, game.id, 'p1', proposedRules);
    expect((await repo.loadGame(game.id))!.pendingHealthRuleProposal).toMatchObject({
      status: 'approved',
      effectiveDay: 3,
    });
  });

  it('applies creator edits immediately while the game is still in the lobby', async () => {
    const setupGame: GameState = {
      ...game,
      status: 'setup',
      dayNumber: 0,
      lobbyHealthVotes: {
        p1: ['run'],
        p2: ['run'],
        p3: [],
      },
    };
    const repo = new InMemoryGameRepository({ games: [setupGame] });

    await proposeHealthRules(repo, game.id, 'p1', proposedRules);

    const saved = (await repo.loadGame(game.id))!;
    expect(saved.config.exercises[0]).toMatchObject({
      key: 'vegetables',
      label: 'Vegetable goal',
      trackingType: 'checkbox',
      dailyUnitCap: 1,
    });
    expect(saved.config.categoryTroopCaps).toEqual({ nutrition: 2 });
    expect(saved.config.dailyTotalTroopCap).toBe(6);
    expect(saved.healthRulesVersion).toBe(2);
    expect(saved.pendingHealthRuleProposal).toBeUndefined();
    expect(saved.lobbyHealthVotes).toEqual({});
  });
});
