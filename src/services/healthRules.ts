import { randomUUID } from 'node:crypto';

import type {
  ExerciseType,
  GameConfig,
  GameState,
  HealthCategory,
  HealthRuleProposal,
  PlayerId,
} from '../engine/types.js';
import type { GameRepository } from './repository.js';

const CATEGORIES: HealthCategory[] = ['movement', 'nutrition', 'recovery'];
const TRACKING_TYPES = ['quantity', 'duration', 'checkbox'] as const;

export interface HealthRulesInput {
  exercises: ExerciseType[];
  categoryTroopCaps?: Partial<Record<HealthCategory, number>>;
  dailyTotalTroopCap: number;
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Validate and normalize creator-supplied rules before they reach game state. */
export function normalizeHealthRules(input: HealthRulesInput): HealthRulesInput {
  if (!Array.isArray(input.exercises) || input.exercises.length < 1 || input.exercises.length > 12) {
    throw new Error('Choose between 1 and 12 health goals');
  }
  if (!finitePositive(input.dailyTotalTroopCap) || input.dailyTotalTroopCap > 50) {
    throw new Error('The daily troop cap must be between 1 and 50');
  }

  const keys = new Set<string>();
  const exercises = input.exercises.map((raw, index) => {
    const label = String(raw.label ?? '').trim().slice(0, 40);
    const key = String(raw.key ?? label)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32);
    const category = CATEGORIES.includes(raw.category as HealthCategory)
      ? raw.category as HealthCategory
      : 'movement';
    const trackingType = TRACKING_TYPES.includes(raw.trackingType as typeof TRACKING_TYPES[number])
      ? raw.trackingType
      : 'quantity';
    const unitLabel = trackingType === 'checkbox'
      ? 'completion'
      : String(raw.unitLabel ?? '').trim().slice(0, 24);
    const dailyUnitCap = trackingType === 'checkbox'
      ? 1
      : raw.dailyUnitCap === null
        ? null
        : Number(raw.dailyUnitCap);
    const troopsPerUnit = Number(raw.troopsPerUnit);

    if (!label || !key) throw new Error(`Health goal ${index + 1} needs a name`);
    if (keys.has(key)) throw new Error(`Health goal names must be unique (${label})`);
    keys.add(key);
    if (!unitLabel) throw new Error(`${label} needs a unit`);
    if (!finitePositive(troopsPerUnit) || troopsPerUnit > 20) {
      throw new Error(`${label} needs a troop value between 0 and 20`);
    }
    if (dailyUnitCap !== null && (!finitePositive(dailyUnitCap) || dailyUnitCap > 10000)) {
      throw new Error(`${label} needs a positive daily limit`);
    }

    return {
      key,
      label,
      unitLabel,
      category,
      trackingType,
      troopsPerUnit,
      dailyUnitCap,
    };
  });

  const categoryTroopCaps: Partial<Record<HealthCategory, number>> = {};
  for (const category of CATEGORIES) {
    const cap = input.categoryTroopCaps?.[category];
    if (cap === undefined || cap === null) continue;
    const numeric = Number(cap);
    if (!finitePositive(numeric) || numeric > input.dailyTotalTroopCap) {
      throw new Error(`${category} cap must be positive and no higher than the daily cap`);
    }
    categoryTroopCaps[category] = numeric;
  }

  return { exercises, categoryTroopCaps, dailyTotalTroopCap: Number(input.dailyTotalTroopCap) };
}

export function withHealthRules(config: GameConfig, input: HealthRulesInput): GameConfig {
  const rules = normalizeHealthRules(input);
  return {
    ...config,
    exercises: rules.exercises,
    categoryTroopCaps: rules.categoryTroopCaps,
    dailyTotalTroopCap: rules.dailyTotalTroopCap,
  };
}

function eligiblePlayers(game: GameState): PlayerId[] {
  return game.players
    .filter((player) => player.status === 'active' || player.status === 'auto_piloted')
    .map((player) => player.id);
}

function reconcileProposal(game: GameState, proposal: HealthRuleProposal): HealthRuleProposal {
  const eligible = eligiblePlayers(game);
  const yes = eligible.filter((id) => proposal.votes[id] === true).length;
  const no = eligible.filter((id) => proposal.votes[id] === false).length;
  const allVoted = yes + no === eligible.length;
  if (yes > eligible.length / 2) {
    return { ...proposal, status: 'approved', effectiveDay: game.dayNumber + 1 };
  }
  if (no > eligible.length / 2 || allVoted) {
    return { ...proposal, status: 'rejected' };
  }
  return proposal;
}

export async function proposeHealthRules(
  repo: GameRepository,
  gameId: string,
  proposedByPlayerId: PlayerId,
  input: HealthRulesInput,
): Promise<GameState> {
  const game = await repo.loadGame(gameId);
  if (!game) throw new Error('Unknown game');
  if (proposedByPlayerId !== game.players[0]?.id) throw new Error('Only the game creator can propose rule changes');
  if (game.pendingHealthRuleProposal?.status === 'pending') {
    throw new Error('A health-rule vote is already in progress');
  }
  const rules = normalizeHealthRules(input);
  let proposal: HealthRuleProposal = {
    id: randomUUID(),
    proposedByPlayerId,
    proposedAtDay: game.dayNumber,
    exercises: rules.exercises,
    categoryTroopCaps: rules.categoryTroopCaps ?? {},
    dailyTotalTroopCap: rules.dailyTotalTroopCap,
    votes: { [proposedByPlayerId]: true },
    status: game.config.healthRuleGovernance === 'vote' ? 'pending' : 'approved',
    effectiveDay: game.config.healthRuleGovernance === 'vote' ? undefined : game.dayNumber + 1,
  };
  if (proposal.status === 'pending') proposal = reconcileProposal(game, proposal);
  const next = { ...game, pendingHealthRuleProposal: proposal };
  await repo.saveGame(next);
  return next;
}

export async function voteOnHealthRules(
  repo: GameRepository,
  gameId: string,
  playerId: PlayerId,
  approve: boolean,
): Promise<GameState> {
  const game = await repo.loadGame(gameId);
  if (!game) throw new Error('Unknown game');
  const proposal = game.pendingHealthRuleProposal;
  if (!proposal || proposal.status !== 'pending') throw new Error('There is no active health-rule vote');
  if (!eligiblePlayers(game).includes(playerId)) throw new Error('This player cannot vote');
  const voted = { ...proposal, votes: { ...proposal.votes, [playerId]: approve } };
  const next = { ...game, pendingHealthRuleProposal: reconcileProposal(game, voted) };
  await repo.saveGame(next);
  return next;
}

/** Apply an approved proposal at the day boundary so every player gets one ruleset per day. */
export function applyApprovedHealthRules(game: GameState, dayNumber: number): GameState {
  const proposal = game.pendingHealthRuleProposal;
  if (!proposal || proposal.status !== 'approved' || (proposal.effectiveDay ?? Infinity) > dayNumber) {
    return game;
  }
  return {
    ...game,
    config: {
      ...game.config,
      exercises: proposal.exercises,
      categoryTroopCaps: proposal.categoryTroopCaps,
      dailyTotalTroopCap: proposal.dailyTotalTroopCap,
    },
    healthRulesVersion: (game.healthRulesVersion ?? 1) + 1,
    pendingHealthRuleProposal: undefined,
    healthRuleHistory: [
      ...(game.healthRuleHistory ?? []),
      {
        dayNumber,
        summary: `${proposal.exercises.length} goals, ${proposal.dailyTotalTroopCap} troop daily cap`,
      },
    ],
  };
}
