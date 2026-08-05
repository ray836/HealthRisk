import { describe, expect, it } from 'vitest';

import {
  createCombatSeedDeriver,
  resolveCombatSeedSecret,
} from '../combatSeed.js';

describe('combat seed derivation', () => {
  it('is stable for the same secret and combat context', () => {
    const derive = createCombatSeedDeriver('a sufficiently private test secret');
    expect(derive('game:4:player:atk:2')).toBe(derive('game:4:player:atk:2'));
  });

  it('changes when either the secret or combat context changes', () => {
    const first = createCombatSeedDeriver('first secret');
    const second = createCombatSeedDeriver('second secret');
    const context = 'game:4:player:atk:2';

    expect(first(context)).not.toBe(first(`${context}:next`));
    expect(first(context)).not.toBe(second(context));
  });

  it('does not expose the public combat context in the derived value', () => {
    const context = 'game:4:player:atk:2';
    const derived = createCombatSeedDeriver('private secret')(context);

    expect(derived).toMatch(/^[a-f0-9]{64}$/);
    expect(derived).not.toContain(context);
  });

  it('prefers a dedicated secret and safely falls back to the cron secret', () => {
    expect(
      resolveCombatSeedSecret({
        NODE_ENV: 'production',
        COMBAT_SEED_SECRET: 'combat-secret',
        CRON_SECRET: 'cron-secret',
      }),
    ).toBe('combat-secret');
    expect(
      resolveCombatSeedSecret({
        NODE_ENV: 'production',
        CRON_SECRET: 'cron-secret',
      }),
    ).toBe('cron-secret');
  });

  it('fails closed in production when no server secret is configured', () => {
    expect(() => resolveCombatSeedSecret({ NODE_ENV: 'production' })).toThrow(
      'COMBAT_SEED_SECRET',
    );
  });
});
