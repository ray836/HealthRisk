/**
 * Core domain types for the Exercise Risk engine.
 *
 * These describe the *game state the engine reasons about* — a pure, in-memory
 * shape. Persistence (Postgres) mirrors these but is defined separately in
 * db/schema.ts. Keeping the engine ignorant of the database is deliberate: the
 * turn logic is pure and testable, and can be validated against any store.
 */

export type PlayerId = string;
export type TerritoryId = string; // e.g. "alaska", "ural" — see map.ts
export type ContinentId = string;
export type HealthCategory = 'movement' | 'nutrition' | 'recovery';
export type HealthTrackingType = 'quantity' | 'duration' | 'checkbox';
export type HealthRuleGovernance = 'creator' | 'vote';

/** A territory owner is either a player, or the neutral garrison (null). */
export type Owner = PlayerId | null;
export const NEUTRAL: Owner = null;

export type PlayerStatus =
  | 'active' // playing normally
  | 'auto_piloted' // still in the game but being auto-resolved (inactive)
  | 'forfeited' // removed by admin; territories converted to neutral
  | 'eliminated'; // lost all territories

export interface Player {
  id: PlayerId;
  name: string;
  status: PlayerStatus;
  /** Troops banked from logged exercise, waiting to be placed next turn. */
  pendingReinforcements: number;
  /** Consecutive daily turns auto-resolved (drives admin/auto forfeit). */
  consecutiveAutoResolvedDays: number;
  /**
   * Persistent, free-text standing orders (§5). If the player misses their
   * window, an AI resolves their full turn from this note. Empty string => the
   * deterministic defensive fallback is used instead. Set-and-forget; editable
   * anytime.
   */
  standingOrdersNote: string;
}

export interface Territory {
  id: TerritoryId;
  owner: Owner;
  /** Armies present. Neutral territories always have >= 1; owned always >= 1. */
  armies: number;
}

/** Exercise → troop conversion, set once by admin at game creation (§3). */
export interface ExerciseType {
  key: string; // e.g. "running"
  label: string; // e.g. "Running"
  unitLabel: string; // e.g. "mile", "minute"
  /** Groups goals for balancing. Older games default to movement. */
  category?: HealthCategory;
  /** Checkbox goals count as one completion per day. */
  trackingType?: HealthTrackingType;
  /** Troops earned per unit. May be fractional (e.g. 1 troop / 30 min). */
  troopsPerUnit: number;
  /** Max *units* countable per day for this exercise (null = uncapped here). */
  dailyUnitCap: number | null;
}

export interface GameConfig {
  exercises: ExerciseType[];
  /** Optional ceilings per health category, applied before the overall cap. */
  categoryTroopCaps?: Partial<Record<HealthCategory, number>>;
  /** Who approves changes proposed while a game is in progress. */
  healthRuleGovernance?: HealthRuleGovernance;
  /** Hard ceiling on total troops earnable per player per day across all types (§3). */
  dailyTotalTroopCap: number;
  /** Turn window opens at this local time each day. Minutes since midnight. */
  windowStartMinuteOfDay: number; // 19:00 => 19*60 = 1140
  /**
   * Minutes each player gets when at the front of the line (§5). A single
   * window — missing it auto-resolves the turn; there is no requeue.
   */
  perPlayerWindowMinutes: number; // default 20
  /** Consecutive auto-resolved days before auto-forfeit (null = admin-only). */
  autoForfeitAfterDays: number | null;
  /** Default stop-loss the AI uses for note-driven attacks (§5). */
  autoAttackStopLoss: number;
  /** Max attacks allowed in one Attack Phase (null = unlimited, per §6). */
  maxAttacksPerTurn: number | null;
  /** IANA timezone the window start is interpreted in, e.g. "America/New_York". */
  timezone: string;
}

export interface HealthRuleProposal {
  id: string;
  proposedByPlayerId: PlayerId;
  proposedAtDay: number;
  exercises: ExerciseType[];
  categoryTroopCaps: Partial<Record<HealthCategory, number>>;
  dailyTotalTroopCap: number;
  votes: Record<PlayerId, boolean>;
  status: 'pending' | 'approved' | 'rejected';
  /** Approved changes begin on the next game day, never partway through today. */
  effectiveDay?: number;
}

export interface HealthRuleHistoryEntry {
  dayNumber: number;
  summary: string;
}

export interface GameState {
  id: string;
  config: GameConfig;
  players: Player[];
  territories: Territory[];
  /** Fixed randomized base line order, set once at game start (§2.5). */
  turnOrder: PlayerId[];
  /** Increments each daily session; day 0 is the first turn window. */
  dayNumber: number;
  status: 'setup' | 'active' | 'finished';
  winnerId?: PlayerId;
  healthRulesVersion?: number;
  pendingHealthRuleProposal?: HealthRuleProposal;
  healthRuleHistory?: HealthRuleHistoryEntry[];
}
