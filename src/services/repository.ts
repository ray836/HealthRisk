/**
 * Persistence seam for the service layer.
 *
 * The engine is pure and store-agnostic; the orchestrator talks to a
 * GameRepository so it can load current state, run the engine, and save the
 * result. A Postgres/Drizzle implementation maps GameState/DailySession onto the
 * tables in db/schema.ts (games/players/territories, turn_sessions/turns); the
 * in-memory implementation below is for tests and local development.
 */

import type { GameState, TerritoryId } from '../engine/types.js';
import type { DailySession } from '../engine/turnSession.js';
import type { ExerciseLogEntry } from '../engine/reinforce.js';

/** Which phase of a player's turn is in progress (§4). */
export type TurnPhase = 'reinforce' | 'attack' | 'fortify' | 'done';

/**
 * Transient per-turn state for an interactive (present) player, persisted so it
 * survives across the stateless turn-API calls that make up one turn. Maps onto
 * the `turns` row (phase) in db/schema.ts.
 */
export interface TurnState {
  gameId: string;
  dayNumber: number;
  playerId: string;
  phase: TurnPhase;
  attacksMade: number;
  /** Standard reinforcements granted at turn start (territory + continent), for display. */
  startBonus?: number;
  /** Exercise-earned troops already banked when this turn began. */
  startExerciseTroops?: number;
  /** Fixed elimination rewards released when this turn began. */
  startEliminationTroops?: number;
  /** Labels of continents the player controlled at turn start. */
  startContinents?: string[];
  /** First territory captured this turn; earns one card when the turn ends. */
  capturedTerritoryId?: TerritoryId;
  /** Recorded after the deterministic conquest-card award is applied. */
  conquestCardAwarded?: boolean;
}

/** A user account. */
export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

/** A bearer session token → user. */
export interface AuthToken {
  token: string;
  userId: string;
  createdAt: string;
}

/** Which user owns a given seat (player) in a game. */
export interface Member {
  gameId: string;
  playerId: string;
  userId: string;
}

export interface GameRepository {
  loadGame(gameId: string): Promise<GameState | null>;
  saveGame(state: GameState): Promise<void>;
  loadSession(gameId: string, dayNumber: number): Promise<DailySession | null>;
  saveSession(session: DailySession): Promise<void>;
  loadTurnState(gameId: string, dayNumber: number, playerId: string): Promise<TurnState | null>;
  saveTurnState(state: TurnState): Promise<void>;
  /** A player's accumulated exercise logs for one day (for cap accounting). */
  loadExerciseLog(gameId: string, dayNumber: number, playerId: string): Promise<ExerciseLogEntry[]>;
  saveExerciseLog(gameId: string, dayNumber: number, playerId: string, entries: ExerciseLogEntry[]): Promise<void>;

  // --- Auth & membership ---
  createUser(user: User): Promise<void>;
  getUserByUsername(username: string): Promise<User | null>;
  getUserById(id: string): Promise<User | null>;
  createToken(token: AuthToken): Promise<void>;
  getToken(token: string): Promise<AuthToken | null>;
  deleteToken(token: string): Promise<void>;
  setMember(member: Member): Promise<void>;
  getMemberByUser(gameId: string, userId: string): Promise<Member | null>;
  getMemberBySeat(gameId: string, playerId: string): Promise<Member | null>;
  listMembers(gameId: string): Promise<Member[]>;
}

/** Deep-ish clone so callers can't mutate stored state by reference. */
function clone<T>(v: T): T {
  return structuredClone(v);
}

export class InMemoryGameRepository implements GameRepository {
  private games = new Map<string, GameState>();
  private sessions = new Map<string, DailySession>();
  private turns = new Map<string, TurnState>();
  private exercise = new Map<string, ExerciseLogEntry[]>();
  private users = new Map<string, User>();
  private tokens = new Map<string, AuthToken>();
  private members = new Map<string, Member>(); // key: gameId:playerId

  constructor(seed?: { games?: GameState[]; sessions?: DailySession[] }) {
    for (const g of seed?.games ?? []) this.games.set(g.id, clone(g));
    for (const s of seed?.sessions ?? []) this.sessions.set(this.key(s.gameId, s.dayNumber), clone(s));
  }

  private key(gameId: string, dayNumber: number): string {
    return `${gameId}:${dayNumber}`;
  }

  private turnKey(gameId: string, dayNumber: number, playerId: string): string {
    return `${gameId}:${dayNumber}:${playerId}`;
  }

  async loadGame(gameId: string): Promise<GameState | null> {
    const g = this.games.get(gameId);
    return g ? clone(g) : null;
  }

  async saveGame(state: GameState): Promise<void> {
    this.games.set(state.id, clone(state));
  }

  async loadSession(gameId: string, dayNumber: number): Promise<DailySession | null> {
    const s = this.sessions.get(this.key(gameId, dayNumber));
    return s ? clone(s) : null;
  }

  async saveSession(session: DailySession): Promise<void> {
    this.sessions.set(this.key(session.gameId, session.dayNumber), clone(session));
  }

  async loadTurnState(gameId: string, dayNumber: number, playerId: string): Promise<TurnState | null> {
    const t = this.turns.get(this.turnKey(gameId, dayNumber, playerId));
    return t ? clone(t) : null;
  }

  async saveTurnState(state: TurnState): Promise<void> {
    this.turns.set(this.turnKey(state.gameId, state.dayNumber, state.playerId), clone(state));
  }

  async loadExerciseLog(gameId: string, dayNumber: number, playerId: string): Promise<ExerciseLogEntry[]> {
    return clone(this.exercise.get(this.turnKey(gameId, dayNumber, playerId)) ?? []);
  }

  async saveExerciseLog(
    gameId: string,
    dayNumber: number,
    playerId: string,
    entries: ExerciseLogEntry[],
  ): Promise<void> {
    this.exercise.set(this.turnKey(gameId, dayNumber, playerId), clone(entries));
  }

  async createUser(user: User): Promise<void> {
    this.users.set(user.id, clone(user));
  }
  async getUserByUsername(username: string): Promise<User | null> {
    for (const u of this.users.values()) if (u.username === username) return clone(u);
    return null;
  }
  async getUserById(id: string): Promise<User | null> {
    const u = this.users.get(id);
    return u ? clone(u) : null;
  }
  async createToken(token: AuthToken): Promise<void> {
    this.tokens.set(token.token, clone(token));
  }
  async getToken(token: string): Promise<AuthToken | null> {
    const t = this.tokens.get(token);
    return t ? clone(t) : null;
  }
  async deleteToken(token: string): Promise<void> {
    this.tokens.delete(token);
  }
  async setMember(member: Member): Promise<void> {
    this.members.set(`${member.gameId}:${member.playerId}`, clone(member));
  }
  async getMemberByUser(gameId: string, userId: string): Promise<Member | null> {
    for (const m of this.members.values()) if (m.gameId === gameId && m.userId === userId) return clone(m);
    return null;
  }
  async getMemberBySeat(gameId: string, playerId: string): Promise<Member | null> {
    const m = this.members.get(`${gameId}:${playerId}`);
    return m ? clone(m) : null;
  }
  async listMembers(gameId: string): Promise<Member[]> {
    return [...this.members.values()].filter((m) => m.gameId === gameId).map(clone);
  }
}
