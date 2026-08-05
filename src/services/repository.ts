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
  /** Event-log length at turn start, freezing the daily briefing for this turn. */
  briefingEventCount?: number;
  /** Interactive actions accumulated during this turn for refresh-safe UI feedback. */
  reinforcementTroopsPlaced?: number;
  reinforcementPlacementsMade?: number;
  attackerLosses?: number;
  defenderLosses?: number;
  territoriesCaptured?: TerritoryId[];
  cardsTraded?: number;
  fortifiedTroops?: number;
  fortifiedFromId?: TerritoryId;
  fortifiedToId?: TerritoryId;
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

/** A stored session digest → user. The raw bearer token is never persisted. */
export interface AuthToken {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

/** Which user owns a given seat (player) in a game. */
export interface Member {
  gameId: string;
  playerId: string;
  userId: string;
}

/** A public, plain-text message in one multiplayer game's conversation. */
export interface ChatMessage {
  id: string;
  gameId: string;
  userId: string;
  playerId: string;
  username: string;
  body: string;
  createdAt: string;
  deletedAt?: string | null;
}

export interface IdempotencyRecord {
  userId: string;
  scope: string;
  key: string;
  requestHash: string;
  responseStatus: number | null;
  responseBody: unknown | null;
  createdAt: string;
  expiresAt: string;
}

export interface DeviceRegistration {
  id: string;
  userId: string;
  platform: 'ios';
  token: string;
  environment: 'sandbox' | 'production';
  createdAt: string;
  updatedAt: string;
  disabledAt?: string | null;
}

export type NotificationType =
  | 'lobby_joined'
  | 'lobby_removed'
  | 'game_started'
  | 'turn_started'
  | 'turn_deadline'
  | 'chat_message'
  | 'game_finished';

export interface UserNotification {
  id: string;
  userId: string;
  gameId?: string | null;
  type: NotificationType;
  title: string;
  body: string;
  deepLink?: string | null;
  createdAt: string;
  readAt?: string | null;
}

export interface ChatReport {
  id: string;
  gameId: string;
  messageId: string;
  reporterUserId: string;
  reason: string;
  status: 'open' | 'reviewed';
  createdAt: string;
}

export interface GameRepository {
  /**
   * Run one logical game operation exclusively. Every read-modify-write flow
   * that advances a game must honor this lock so separate serverless
   * invocations cannot resolve the same turn concurrently.
   */
  withGameLock<T>(gameId: string, action: () => Promise<T>): Promise<T>;
  loadGame(gameId: string): Promise<GameState | null>;
  /** All persisted games, used to restore active schedules after a restart. */
  listGames(): Promise<GameState[]>;
  saveGame(state: GameState): Promise<void>;
  /** Permanently remove one game and all game-scoped persisted data. */
  deleteGame(gameId: string): Promise<void>;
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
  deleteUser(id: string): Promise<void>;
  createToken(token: AuthToken): Promise<void>;
  getToken(tokenHash: string): Promise<AuthToken | null>;
  deleteToken(tokenHash: string): Promise<void>;
  deleteTokensForUser(userId: string): Promise<void>;
  setMember(member: Member): Promise<void>;
  deleteMember(gameId: string, playerId: string): Promise<void>;
  getMemberByUser(gameId: string, userId: string): Promise<Member | null>;
  getMemberBySeat(gameId: string, playerId: string): Promise<Member | null>;
  listMembers(gameId: string): Promise<Member[]>;
  listMembersForUser(userId: string): Promise<Member[]>;
  saveChatMessage(message: ChatMessage): Promise<void>;
  /** Oldest-to-newest messages from the most recent bounded page. */
  listChatMessages(gameId: string, limit?: number): Promise<ChatMessage[]>;
  getChatMessage(messageId: string): Promise<ChatMessage | null>;
  softDeleteChatMessage(messageId: string, deletedAt: string): Promise<void>;
  countRecentChatMessages(gameId: string, userId: string, since: string): Promise<number>;
  setChatMute(gameId: string, userId: string, mutedUserId: string, createdAt: string): Promise<void>;
  deleteChatMute(gameId: string, userId: string, mutedUserId: string): Promise<void>;
  listMutedUserIds(gameId: string, userId: string): Promise<string[]>;
  saveChatReport(report: ChatReport): Promise<void>;
  anonymizeChatMessagesByUser(userId: string): Promise<void>;
  reserveIdempotency(record: IdempotencyRecord): Promise<boolean>;
  getIdempotency(userId: string, scope: string, key: string): Promise<IdempotencyRecord | null>;
  completeIdempotency(userId: string, scope: string, key: string, responseStatus: number, responseBody: unknown): Promise<void>;
  deleteIdempotency(userId: string, scope: string, key: string): Promise<void>;
  upsertDeviceRegistration(registration: DeviceRegistration): Promise<DeviceRegistration>;
  listDeviceRegistrations(userId: string): Promise<DeviceRegistration[]>;
  deleteDeviceRegistration(id: string, userId: string): Promise<void>;
  saveNotification(notification: UserNotification): Promise<void>;
  listNotifications(userId: string, limit?: number): Promise<UserNotification[]>;
  markNotificationRead(id: string, userId: string, readAt: string): Promise<void>;
  deletePrivateUserData(userId: string): Promise<void>;
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
  private chatMessages = new Map<string, ChatMessage>();
  private idempotency = new Map<string, IdempotencyRecord>();
  private devices = new Map<string, DeviceRegistration>();
  private notifications = new Map<string, UserNotification>();
  private chatMutes = new Map<string, string>();
  private chatReports = new Map<string, ChatReport>();
  private gameLockTails = new Map<string, Promise<void>>();

  constructor(seed?: {
    games?: GameState[];
    sessions?: DailySession[];
    chatMessages?: ChatMessage[];
  }) {
    for (const g of seed?.games ?? []) this.games.set(g.id, clone(g));
    for (const s of seed?.sessions ?? []) this.sessions.set(this.key(s.gameId, s.dayNumber), clone(s));
    for (const message of seed?.chatMessages ?? []) this.chatMessages.set(message.id, clone(message));
  }

  private key(gameId: string, dayNumber: number): string {
    return `${gameId}:${dayNumber}`;
  }

  private turnKey(gameId: string, dayNumber: number, playerId: string): string {
    return `${gameId}:${dayNumber}:${playerId}`;
  }

  async withGameLock<T>(gameId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.gameLockTails.get(gameId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.gameLockTails.set(gameId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.gameLockTails.get(gameId) === tail) this.gameLockTails.delete(gameId);
    }
  }

  async loadGame(gameId: string): Promise<GameState | null> {
    const g = this.games.get(gameId);
    return g ? clone(g) : null;
  }

  async listGames(): Promise<GameState[]> {
    return [...this.games.values()].map(clone);
  }

  async saveGame(state: GameState): Promise<void> {
    this.games.set(state.id, clone(state));
  }

  async deleteGame(gameId: string): Promise<void> {
    this.games.delete(gameId);
    const prefix = `${gameId}:`;
    for (const key of this.sessions.keys()) if (key.startsWith(prefix)) this.sessions.delete(key);
    for (const key of this.turns.keys()) if (key.startsWith(prefix)) this.turns.delete(key);
    for (const key of this.exercise.keys()) if (key.startsWith(prefix)) this.exercise.delete(key);
    for (const key of this.members.keys()) if (key.startsWith(prefix)) this.members.delete(key);
    for (const [id, message] of this.chatMessages) {
      if (message.gameId === gameId) this.chatMessages.delete(id);
    }
    for (const key of this.chatMutes.keys()) if (key.startsWith(prefix)) this.chatMutes.delete(key);
    for (const [id, report] of this.chatReports) {
      if (report.gameId === gameId) this.chatReports.delete(id);
    }
    for (const [id, notification] of this.notifications) {
      if (notification.gameId === gameId) this.notifications.delete(id);
    }
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
  async deleteUser(id: string): Promise<void> {
    this.users.delete(id);
  }
  async createToken(token: AuthToken): Promise<void> {
    this.tokens.set(token.tokenHash, clone(token));
  }
  async getToken(tokenHash: string): Promise<AuthToken | null> {
    const t = this.tokens.get(tokenHash);
    return t ? clone(t) : null;
  }
  async deleteToken(tokenHash: string): Promise<void> {
    this.tokens.delete(tokenHash);
  }
  async deleteTokensForUser(userId: string): Promise<void> {
    for (const [key, token] of this.tokens) {
      if (token.userId === userId) this.tokens.delete(key);
    }
  }
  async setMember(member: Member): Promise<void> {
    this.members.set(`${member.gameId}:${member.playerId}`, clone(member));
  }
  async deleteMember(gameId: string, playerId: string): Promise<void> {
    this.members.delete(`${gameId}:${playerId}`);
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
  async listMembersForUser(userId: string): Promise<Member[]> {
    return [...this.members.values()].filter((m) => m.userId === userId).map(clone);
  }
  async saveChatMessage(message: ChatMessage): Promise<void> {
    this.chatMessages.set(message.id, clone(message));
  }
  async listChatMessages(gameId: string, limit = 50): Promise<ChatMessage[]> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return [...this.chatMessages.values()]
      .filter((message) => message.gameId === gameId)
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .slice(-boundedLimit)
      .map(clone);
  }
  async getChatMessage(messageId: string): Promise<ChatMessage | null> {
    const message = this.chatMessages.get(messageId);
    return message ? clone(message) : null;
  }
  async softDeleteChatMessage(messageId: string, deletedAt: string): Promise<void> {
    const message = this.chatMessages.get(messageId);
    if (message) this.chatMessages.set(messageId, { ...message, body: '', deletedAt });
  }
  async countRecentChatMessages(gameId: string, userId: string, since: string): Promise<number> {
    return [...this.chatMessages.values()].filter(
      (message) => message.gameId === gameId && message.userId === userId && message.createdAt >= since,
    ).length;
  }
  async setChatMute(gameId: string, userId: string, mutedUserId: string, createdAt: string): Promise<void> {
    this.chatMutes.set(`${gameId}:${userId}:${mutedUserId}`, createdAt);
  }
  async deleteChatMute(gameId: string, userId: string, mutedUserId: string): Promise<void> {
    this.chatMutes.delete(`${gameId}:${userId}:${mutedUserId}`);
  }
  async listMutedUserIds(gameId: string, userId: string): Promise<string[]> {
    const prefix = `${gameId}:${userId}:`;
    return [...this.chatMutes.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }
  async saveChatReport(report: ChatReport): Promise<void> {
    const duplicate = [...this.chatReports.values()].some(
      (item) => item.messageId === report.messageId && item.reporterUserId === report.reporterUserId,
    );
    if (!duplicate) this.chatReports.set(report.id, clone(report));
  }
  async anonymizeChatMessagesByUser(userId: string): Promise<void> {
    for (const [id, message] of this.chatMessages) {
      if (message.userId === userId) {
        this.chatMessages.set(id, { ...message, userId: 'deleted-user', username: 'Deleted player' });
      }
    }
  }
  private idempotencyKey(userId: string, scope: string, key: string): string {
    return `${userId}:${scope}:${key}`;
  }
  async reserveIdempotency(record: IdempotencyRecord): Promise<boolean> {
    const key = this.idempotencyKey(record.userId, record.scope, record.key);
    if (this.idempotency.has(key)) return false;
    this.idempotency.set(key, clone(record));
    return true;
  }
  async getIdempotency(userId: string, scope: string, key: string): Promise<IdempotencyRecord | null> {
    const record = this.idempotency.get(this.idempotencyKey(userId, scope, key));
    return record ? clone(record) : null;
  }
  async completeIdempotency(
    userId: string,
    scope: string,
    key: string,
    responseStatus: number,
    responseBody: unknown,
  ): Promise<void> {
    const storageKey = this.idempotencyKey(userId, scope, key);
    const record = this.idempotency.get(storageKey);
    if (record) {
      this.idempotency.set(storageKey, { ...record, responseStatus, responseBody: clone(responseBody) });
    }
  }
  async deleteIdempotency(userId: string, scope: string, key: string): Promise<void> {
    this.idempotency.delete(this.idempotencyKey(userId, scope, key));
  }
  async upsertDeviceRegistration(registration: DeviceRegistration): Promise<DeviceRegistration> {
    const existing = [...this.devices.values()].find((device) => device.token === registration.token);
    const stored = existing
      ? { ...registration, id: existing.id, createdAt: existing.createdAt }
      : registration;
    this.devices.set(stored.id, clone(stored));
    return clone(stored);
  }
  async listDeviceRegistrations(userId: string): Promise<DeviceRegistration[]> {
    return [...this.devices.values()].filter((device) => device.userId === userId).map(clone);
  }
  async deleteDeviceRegistration(id: string, userId: string): Promise<void> {
    const device = this.devices.get(id);
    if (device?.userId === userId) this.devices.delete(id);
  }
  async saveNotification(notification: UserNotification): Promise<void> {
    this.notifications.set(notification.id, clone(notification));
  }
  async listNotifications(userId: string, limit = 50): Promise<UserNotification[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return [...this.notifications.values()]
      .filter((notification) => notification.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, bounded)
      .map(clone);
  }
  async markNotificationRead(id: string, userId: string, readAt: string): Promise<void> {
    const notification = this.notifications.get(id);
    if (notification?.userId === userId) this.notifications.set(id, { ...notification, readAt });
  }
  async deletePrivateUserData(userId: string): Promise<void> {
    for (const [id, device] of this.devices) if (device.userId === userId) this.devices.delete(id);
    for (const [id, notification] of this.notifications) {
      if (notification.userId === userId) this.notifications.delete(id);
    }
    for (const [key] of this.chatMutes) if (key.includes(`:${userId}:`)) this.chatMutes.delete(key);
    for (const [id, report] of this.chatReports) {
      if (report.reporterUserId === userId) this.chatReports.delete(id);
    }
    for (const [key, record] of this.idempotency) {
      if (record.userId === userId) this.idempotency.delete(key);
    }
  }
}
