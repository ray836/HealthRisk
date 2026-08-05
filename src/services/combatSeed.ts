import { createHmac } from 'node:crypto';

/** Converts a stable combat context into an opaque, reproducible seed input. */
export type CombatSeedDeriver = (context: string) => string;

const DOMAIN = 'healthrisk-combat-v1';
const LOCAL_DEVELOPMENT_SECRET = 'healthrisk-local-development-combat-seed';

/**
 * Build a deterministic combat-seed derivation function without exposing the
 * server secret. HMAC keeps future rolls unpredictable even when clients know
 * every non-secret part of the combat context.
 */
export function createCombatSeedDeriver(secret: string): CombatSeedDeriver {
  if (!secret.trim()) throw new Error('Combat seed secret must not be empty');
  return (context) =>
    createHmac('sha256', secret)
      .update(DOMAIN)
      .update('\0')
      .update(context)
      .digest('hex');
}

/**
 * Production must have a high-entropy secret. A dedicated value is preferred;
 * the already-required cron secret is a safe backwards-compatible fallback.
 * Local development uses a stable non-secret value so saved games remain
 * reproducible across restarts.
 */
export function resolveCombatSeedSecret(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured =
    environment.COMBAT_SEED_SECRET?.trim() || environment.CRON_SECRET?.trim();
  if (configured) return configured;
  if (environment.NODE_ENV === 'production') {
    throw new Error(
      'Set COMBAT_SEED_SECRET (or CRON_SECRET) to a high-entropy server-only value',
    );
  }
  return LOCAL_DEVELOPMENT_SECRET;
}
