import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { buildUserPrompt, coercePlan, createAiPlanner } from '../aiPlanner.js';
import type { PlannerContext } from '../../engine/planner.js';

const ctx: PlannerContext = {
  gameId: 'g',
  dayNumber: 3,
  playerId: 'a',
  note: 'push into South America from venezuela, otherwise hold my borders',
  pendingReinforcements: 5,
  defaultStopLoss: 3,
  maxAttacksPerTurn: null,
  ownedTerritories: [
    {
      id: 'venezuela',
      armies: 10,
      owner: 'a',
      mine: true,
      neighbors: [
        { id: 'brazil', armies: 1, owner: 'b', mine: false },
        { id: 'central_america', armies: 3, owner: 'a', mine: true },
      ],
    },
  ],
  legalAttacks: [{ fromId: 'venezuela', toId: 'brazil', maxCommit: 9, defenderArmies: 1 }],
};

describe('buildUserPrompt', () => {
  it('includes the bank, note, holdings and legal edges', () => {
    const p = buildUserPrompt(ctx);
    expect(p).toContain('Banked reinforcements to place: 5');
    expect(p).toContain('push into South America');
    expect(p).toContain('venezuela: armies=10');
    expect(p).toContain('from venezuela (maxCommit 9) -> brazil');
  });

  it('marks an empty note as defensive', () => {
    const p = buildUserPrompt({ ...ctx, note: '   ' });
    expect(p).toContain('(empty — play defensively, no attacks)');
  });
});

describe('coercePlan', () => {
  it('keeps well-formed placements, attacks, fortify and rationale', () => {
    const plan = coercePlan({
      placements: [{ territoryId: 'venezuela', count: 5 }],
      attacks: [{ fromId: 'venezuela', toId: 'brazil', committedTroops: 12, stopLoss: 3 }],
      fortify: { fromId: 'central_america', toId: 'venezuela', count: 2 },
      rationale: 'push south',
    });
    expect(plan.placements).toHaveLength(1);
    expect(plan.attacks[0]!.toId).toBe('brazil');
    expect(plan.fortify).toEqual({ fromId: 'central_america', toId: 'venezuela', count: 2 });
    expect(plan.rationale).toBe('push south');
  });

  it('drops malformed entries and handles null fortify', () => {
    const plan = coercePlan({
      placements: [
        { territoryId: 'venezuela', count: 3 },
        { territoryId: 'venezuela', count: 0 }, // non-positive -> dropped
        { count: 2 }, // no territory -> dropped
      ],
      attacks: [{ fromId: 'venezuela' }], // incomplete -> dropped
      fortify: null,
      rationale: 42, // wrong type -> dropped
    });
    expect(plan.placements).toHaveLength(1);
    expect(plan.attacks).toHaveLength(0);
    expect(plan.fortify).toBeUndefined();
    expect(plan.rationale).toBeUndefined();
  });

  it('tolerates completely empty / garbage input', () => {
    expect(coercePlan(null)).toEqual({ placements: [], attacks: [] });
    expect(coercePlan({ nonsense: true })).toEqual({ placements: [], attacks: [] });
  });
});

/** Minimal fake Anthropic client returning a canned message. */
function fakeClient(message: Partial<Anthropic.Message>): Anthropic {
  return {
    messages: { create: async () => message },
  } as unknown as Anthropic;
}

describe('createAiPlanner', () => {
  it('parses the model JSON into a TurnPlan', async () => {
    const planJson = JSON.stringify({
      placements: [{ territoryId: 'venezuela', count: 5 }],
      attacks: [{ fromId: 'venezuela', toId: 'brazil', committedTroops: 12, stopLoss: 3 }],
      fortify: null,
      rationale: 'push south',
    });
    const planner = createAiPlanner({
      client: fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: planJson } as Anthropic.TextBlock] }),
    });
    const plan = await planner(ctx);
    expect(plan.placements).toEqual([{ territoryId: 'venezuela', count: 5 }]);
    expect(plan.attacks[0]!.committedTroops).toBe(12);
  });

  it('throws on a refusal (caller falls back to defensive)', async () => {
    const planner = createAiPlanner({
      client: fakeClient({ stop_reason: 'refusal', content: [] }),
    });
    await expect(planner(ctx)).rejects.toThrow(/refused/);
  });

  it('throws on non-JSON output', async () => {
    const planner = createAiPlanner({
      client: fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' } as Anthropic.TextBlock] }),
    });
    await expect(planner(ctx)).rejects.toThrow(/non-JSON/);
  });
});
