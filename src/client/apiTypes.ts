import type {
  ExerciseType,
  GameEvent,
  HealthCategory,
  HealthRuleGovernance,
  HealthRuleProposal,
  HealthTrackingType,
  PlayerStatus,
  TerritoryId,
} from '../engine/types.js';
import type { PlayerDashboard } from '../services/playerDashboard.js';
import type { SharedHealthProgress } from '../services/sharedHealthProgress.js';

/**
 * Serializable API contracts shared by the browser client and future native
 * clients. Keep browser-only state and server implementation types out of here.
 */

export interface PublicUser {
  id: string;
  username: string;
}

export interface AuthRequest {
  username: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: PublicUser;
}

export interface CurrentUserResponse {
  user: PublicUser | null;
  activeMultiplayerGameId: string | null;
}

export interface ApiErrorResponse {
  error: string;
  message?: string;
}

export interface HealthLoggingView {
  allowed: boolean;
  playerId: string | null;
  playerName: string | null;
  appliesTo: 'current_move' | 'upcoming_move' | 'next_move' | null;
  reason: 'game_not_active' | 'out_of_game' | 'no_seat' | null;
}

export interface GameScheduleView {
  timezone: string;
  dailyStartMinuteOfDay: number;
  playerWindowMinutes: number;
  moveDeadlineAt: string | null;
  nextSessionOpensAt: string | null;
  missedTurnPolicy: 'auto_resolve';
}

export interface GamePlayerView {
  id: string;
  name: string;
  status: PlayerStatus;
  color?: string;
  pendingReinforcements: number;
  pendingEliminationReward: number;
  note: string;
  claimed: boolean;
  healthProgress: SharedHealthProgress | null;
}

export interface ExerciseRuleView {
  key: string;
  label: string;
  unitLabel: string;
  category: HealthCategory;
  trackingType: HealthTrackingType;
  troopsPerUnit: number;
  dailyUnitCap: number | null;
}

export interface ContinentView {
  id: string;
  label: string;
  bonus: number;
}

export interface TerritoryView {
  id: TerritoryId;
  owner: string | null;
  armies: number;
  continent: string;
  neighbors: TerritoryId[];
  color: string;
}

export interface GameView {
  id: string;
  revision: number;
  practice: boolean;
  activeMultiplayerGameId: string | null;
  status: 'setup' | 'active' | 'finished' | 'cancelled';
  winnerId: string | null;
  events: GameEvent[];
  dayNumber: number;
  turnOrder: string[];
  currentPlayerId: string | null;
  mySeats: string[];
  isCreator: boolean;
  yourTurn: boolean;
  dashboard: PlayerDashboard | null;
  healthLogging: HealthLoggingView;
  phase: 'reinforce' | 'attack' | 'fortify' | 'done';
  startBonus: number;
  startContinents: string[];
  windowExpiresAt: string | null;
  nextSessionOpensAt: string | null;
  perPlayerWindowMinutes: number;
  schedule: GameScheduleView;
  claimedPlayerCount: number;
  players: GamePlayerView[];
  exercises: ExerciseRuleView[];
  categoryTroopCaps: Partial<Record<HealthCategory, number>>;
  healthRuleGovernance: HealthRuleGovernance;
  healthRulesVersion: number;
  pendingHealthRuleProposal: HealthRuleProposal | null;
  dailyTotalTroopCap: number;
  continents: ContinentView[];
  territories: TerritoryView[];
}

export interface HealthRulesRequest {
  exercises: ExerciseType[];
  categoryTroopCaps?: Partial<Record<HealthCategory, number>>;
  dailyTotalTroopCap: number;
  healthRuleGovernance?: HealthRuleGovernance;
}

export interface CreateGameRequest {
  players: number;
  practice: boolean;
  healthRules?: HealthRulesRequest;
  healthRuleGovernance?: HealthRuleGovernance;
  dailyStartMinuteOfDay?: number;
  timezone?: string;
}

export interface GameResponse {
  game: GameView;
}

export interface JoinGameResponse extends GameResponse {
  seat: string;
}

export interface LeaveGameResponse extends GameResponse {
  ok: true;
  activeMultiplayerGameId: string | null;
}

export interface LogHealthProgressRequest {
  playerId?: string;
  exerciseKey: string;
  units: number;
}

export interface LogHealthProgressResponse extends GameResponse {
  earned: {
    total: number;
    perExercise: Record<string, number>;
    totalCapApplied: boolean;
  };
}

export type GameMutationResponse = GameResponse & Record<string, unknown>;
