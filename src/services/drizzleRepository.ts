/**
 * Postgres/PGlite-backed GameRepository (the durable counterpart to
 * InMemoryGameRepository). Persists each engine value as a jsonb snapshot via
 * the store schema in db/store.ts, so games survive process restarts.
 *
 * The engine's load→run→save value semantics map directly onto upserts here.
 */

import { and, desc, eq, gte, or } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client.js';
import {
  authTokens,
  chatMutes,
  chatReports,
  chatMessages,
  deviceRegistrations,
  exerciseLogs,
  games,
  members,
  idempotencyRecords,
  sessions,
  turnStates,
  users,
  userNotifications,
} from '../../db/store.js';
import type {
  AuthToken,
  ChatReport,
  ChatMessage,
  DeviceRegistration,
  GameRepository,
  IdempotencyRecord,
  Member,
  TurnState,
  User,
  UserNotification,
} from './repository.js';
import type { GameState } from '../engine/types.js';
import type { DailySession } from '../engine/turnSession.js';
import type { ExerciseLogEntry } from '../engine/reinforce.js';

export class DrizzleGameRepository implements GameRepository {
  // drizzle's per-driver db types diverge in their generics; the pg query
  // builder surface is identical, so we widen to `any` at the boundary only.
  private db: any;
  private lock: <T>(gameId: string, action: () => Promise<T>) => Promise<T>;
  private localLockTails = new Map<string, Promise<void>>();

  constructor(
    db: AppDatabase,
    lock?: <T>(gameId: string, action: () => Promise<T>) => Promise<T>,
  ) {
    this.db = db;
    this.lock = lock ?? ((gameId, action) => this.withLocalLock(gameId, action));
  }

  async withGameLock<T>(gameId: string, action: () => Promise<T>): Promise<T> {
    return this.lock(gameId, action);
  }

  private async withLocalLock<T>(gameId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.localLockTails.get(gameId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.localLockTails.set(gameId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.localLockTails.get(gameId) === tail) this.localLockTails.delete(gameId);
    }
  }

  async loadGame(gameId: string): Promise<GameState | null> {
    const rows = await this.db.select().from(games).where(eq(games.id, gameId));
    return rows.length ? (rows[0].state as GameState) : null;
  }

  async listGames(): Promise<GameState[]> {
    const rows = await this.db.select().from(games);
    return rows.map((row: { state: GameState }) => row.state);
  }

  async saveGame(state: GameState): Promise<void> {
    await this.db
      .insert(games)
      .values({ id: state.id, state })
      .onConflictDoUpdate({ target: games.id, set: { state, updatedAt: new Date() } });
  }

  async loadSession(gameId: string, dayNumber: number): Promise<DailySession | null> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.gameId, gameId), eq(sessions.dayNumber, dayNumber)));
    return rows.length ? (rows[0].session as DailySession) : null;
  }

  async saveSession(session: DailySession): Promise<void> {
    await this.db
      .insert(sessions)
      .values({ gameId: session.gameId, dayNumber: session.dayNumber, session })
      .onConflictDoUpdate({ target: [sessions.gameId, sessions.dayNumber], set: { session } });
  }

  async loadTurnState(gameId: string, dayNumber: number, playerId: string): Promise<TurnState | null> {
    const rows = await this.db
      .select()
      .from(turnStates)
      .where(
        and(eq(turnStates.gameId, gameId), eq(turnStates.dayNumber, dayNumber), eq(turnStates.playerId, playerId)),
      );
    return rows.length ? (rows[0].state as TurnState) : null;
  }

  async saveTurnState(state: TurnState): Promise<void> {
    await this.db
      .insert(turnStates)
      .values({ gameId: state.gameId, dayNumber: state.dayNumber, playerId: state.playerId, state })
      .onConflictDoUpdate({
        target: [turnStates.gameId, turnStates.dayNumber, turnStates.playerId],
        set: { state },
      });
  }

  async loadExerciseLog(gameId: string, dayNumber: number, playerId: string): Promise<ExerciseLogEntry[]> {
    const rows = await this.db
      .select()
      .from(exerciseLogs)
      .where(
        and(eq(exerciseLogs.gameId, gameId), eq(exerciseLogs.dayNumber, dayNumber), eq(exerciseLogs.playerId, playerId)),
      );
    return rows.length ? (rows[0].entries as ExerciseLogEntry[]) : [];
  }

  async saveExerciseLog(
    gameId: string,
    dayNumber: number,
    playerId: string,
    entries: ExerciseLogEntry[],
  ): Promise<void> {
    await this.db
      .insert(exerciseLogs)
      .values({ gameId, dayNumber, playerId, entries })
      .onConflictDoUpdate({
        target: [exerciseLogs.gameId, exerciseLogs.dayNumber, exerciseLogs.playerId],
        set: { entries },
      });
  }

  async createUser(user: User): Promise<void> {
    await this.db.insert(users).values(user);
  }
  async getUserByUsername(username: string): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.username, username));
    return rows.length ? (rows[0] as User) : null;
  }
  async getUserById(id: string): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id));
    return rows.length ? (rows[0] as User) : null;
  }
  async deleteUser(id: string): Promise<void> {
    await this.db.delete(users).where(eq(users.id, id));
  }
  async createToken(token: AuthToken): Promise<void> {
    await this.db.insert(authTokens).values(token);
  }
  async getToken(tokenHash: string): Promise<AuthToken | null> {
    const rows = await this.db.select().from(authTokens).where(eq(authTokens.tokenHash, tokenHash));
    return rows.length ? (rows[0] as AuthToken) : null;
  }
  async deleteToken(tokenHash: string): Promise<void> {
    await this.db.delete(authTokens).where(eq(authTokens.tokenHash, tokenHash));
  }
  async deleteTokensForUser(userId: string): Promise<void> {
    await this.db.delete(authTokens).where(eq(authTokens.userId, userId));
  }
  async setMember(member: Member): Promise<void> {
    await this.db
      .insert(members)
      .values(member)
      .onConflictDoUpdate({ target: [members.gameId, members.playerId], set: { userId: member.userId } });
  }
  async deleteMember(gameId: string, playerId: string): Promise<void> {
    await this.db
      .delete(members)
      .where(and(eq(members.gameId, gameId), eq(members.playerId, playerId)));
  }
  async getMemberByUser(gameId: string, userId: string): Promise<Member | null> {
    const rows = await this.db
      .select()
      .from(members)
      .where(and(eq(members.gameId, gameId), eq(members.userId, userId)));
    return rows.length ? (rows[0] as Member) : null;
  }
  async getMemberBySeat(gameId: string, playerId: string): Promise<Member | null> {
    const rows = await this.db
      .select()
      .from(members)
      .where(and(eq(members.gameId, gameId), eq(members.playerId, playerId)));
    return rows.length ? (rows[0] as Member) : null;
  }
  async listMembers(gameId: string): Promise<Member[]> {
    return (await this.db.select().from(members).where(eq(members.gameId, gameId))) as Member[];
  }
  async listMembersForUser(userId: string): Promise<Member[]> {
    return (await this.db.select().from(members).where(eq(members.userId, userId))) as Member[];
  }
  async saveChatMessage(message: ChatMessage): Promise<void> {
    await this.db.insert(chatMessages).values(message);
  }
  async listChatMessages(gameId: string, limit = 50): Promise<ChatMessage[]> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.gameId, gameId))
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
      .limit(boundedLimit);
    return (rows as ChatMessage[]).reverse();
  }
  async getChatMessage(messageId: string): Promise<ChatMessage | null> {
    const rows = await this.db.select().from(chatMessages).where(eq(chatMessages.id, messageId));
    return rows.length ? (rows[0] as ChatMessage) : null;
  }
  async softDeleteChatMessage(messageId: string, deletedAt: string): Promise<void> {
    await this.db
      .update(chatMessages)
      .set({ body: '', deletedAt })
      .where(eq(chatMessages.id, messageId));
  }
  async countRecentChatMessages(gameId: string, userId: string, since: string): Promise<number> {
    const rows = await this.db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.gameId, gameId),
          eq(chatMessages.userId, userId),
          gte(chatMessages.createdAt, since),
        ),
      );
    return rows.length;
  }
  async setChatMute(gameId: string, userId: string, mutedUserId: string, createdAt: string): Promise<void> {
    await this.db
      .insert(chatMutes)
      .values({ gameId, userId, mutedUserId, createdAt })
      .onConflictDoNothing();
  }
  async deleteChatMute(gameId: string, userId: string, mutedUserId: string): Promise<void> {
    await this.db.delete(chatMutes).where(
      and(
        eq(chatMutes.gameId, gameId),
        eq(chatMutes.userId, userId),
        eq(chatMutes.mutedUserId, mutedUserId),
      ),
    );
  }
  async listMutedUserIds(gameId: string, userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ mutedUserId: chatMutes.mutedUserId })
      .from(chatMutes)
      .where(and(eq(chatMutes.gameId, gameId), eq(chatMutes.userId, userId)));
    return rows.map((row: { mutedUserId: string }) => row.mutedUserId);
  }
  async saveChatReport(report: ChatReport): Promise<void> {
    await this.db.insert(chatReports).values(report).onConflictDoNothing();
  }
  async anonymizeChatMessagesByUser(userId: string): Promise<void> {
    await this.db
      .update(chatMessages)
      .set({ userId: 'deleted-user', username: 'Deleted player' })
      .where(eq(chatMessages.userId, userId));
  }
  async reserveIdempotency(record: IdempotencyRecord): Promise<boolean> {
    const rows = await this.db
      .insert(idempotencyRecords)
      .values(record)
      .onConflictDoNothing()
      .returning({ key: idempotencyRecords.key });
    return rows.length > 0;
  }
  async getIdempotency(userId: string, scope: string, key: string): Promise<IdempotencyRecord | null> {
    const rows = await this.db.select().from(idempotencyRecords).where(
      and(
        eq(idempotencyRecords.userId, userId),
        eq(idempotencyRecords.scope, scope),
        eq(idempotencyRecords.key, key),
      ),
    );
    return rows.length ? (rows[0] as IdempotencyRecord) : null;
  }
  async completeIdempotency(
    userId: string,
    scope: string,
    key: string,
    responseStatus: number,
    responseBody: unknown,
  ): Promise<void> {
    await this.db
      .update(idempotencyRecords)
      .set({ responseStatus, responseBody })
      .where(
        and(
          eq(idempotencyRecords.userId, userId),
          eq(idempotencyRecords.scope, scope),
          eq(idempotencyRecords.key, key),
        ),
      );
  }
  async deleteIdempotency(userId: string, scope: string, key: string): Promise<void> {
    await this.db.delete(idempotencyRecords).where(
      and(
        eq(idempotencyRecords.userId, userId),
        eq(idempotencyRecords.scope, scope),
        eq(idempotencyRecords.key, key),
      ),
    );
  }
  async upsertDeviceRegistration(registration: DeviceRegistration): Promise<DeviceRegistration> {
    await this.db
      .insert(deviceRegistrations)
      .values(registration)
      .onConflictDoUpdate({
        target: deviceRegistrations.token,
        set: {
          userId: registration.userId,
          platform: registration.platform,
          environment: registration.environment,
          updatedAt: registration.updatedAt,
          disabledAt: null,
        },
      });
    const rows = await this.db
      .select()
      .from(deviceRegistrations)
      .where(eq(deviceRegistrations.token, registration.token));
    return rows[0] as DeviceRegistration;
  }
  async listDeviceRegistrations(userId: string): Promise<DeviceRegistration[]> {
    return (await this.db
      .select()
      .from(deviceRegistrations)
      .where(eq(deviceRegistrations.userId, userId))) as DeviceRegistration[];
  }
  async deleteDeviceRegistration(id: string, userId: string): Promise<void> {
    await this.db.delete(deviceRegistrations).where(
      and(eq(deviceRegistrations.id, id), eq(deviceRegistrations.userId, userId)),
    );
  }
  async saveNotification(notification: UserNotification): Promise<void> {
    await this.db.insert(userNotifications).values(notification);
  }
  async listNotifications(userId: string, limit = 50): Promise<UserNotification[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return (await this.db
      .select()
      .from(userNotifications)
      .where(eq(userNotifications.userId, userId))
      .orderBy(desc(userNotifications.createdAt))
      .limit(bounded)) as UserNotification[];
  }
  async markNotificationRead(id: string, userId: string, readAt: string): Promise<void> {
    await this.db
      .update(userNotifications)
      .set({ readAt })
      .where(and(eq(userNotifications.id, id), eq(userNotifications.userId, userId)));
  }
  async deletePrivateUserData(userId: string): Promise<void> {
    await this.db.delete(deviceRegistrations).where(eq(deviceRegistrations.userId, userId));
    await this.db.delete(userNotifications).where(eq(userNotifications.userId, userId));
    await this.db.delete(chatMutes).where(
      or(eq(chatMutes.userId, userId), eq(chatMutes.mutedUserId, userId)),
    );
    await this.db.delete(chatReports).where(eq(chatReports.reporterUserId, userId));
    await this.db.delete(idempotencyRecords).where(eq(idempotencyRecords.userId, userId));
  }
}
