/**
 * Postgres/PGlite-backed GameRepository (the durable counterpart to
 * InMemoryGameRepository). Persists each engine value as a jsonb snapshot via
 * the store schema in db/store.ts, so games survive process restarts.
 *
 * The engine's load→run→save value semantics map directly onto upserts here.
 */

import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client.js';
import { games, sessions, turnStates, exerciseLogs, users, authTokens, members } from '../../db/store.js';
import type { AuthToken, GameRepository, Member, TurnState, User } from './repository.js';
import type { GameState } from '../engine/types.js';
import type { DailySession } from '../engine/turnSession.js';
import type { ExerciseLogEntry } from '../engine/reinforce.js';

export class DrizzleGameRepository implements GameRepository {
  // drizzle's per-driver db types diverge in their generics; the pg query
  // builder surface is identical, so we widen to `any` at the boundary only.
  private db: any;
  constructor(db: AppDatabase) {
    this.db = db;
  }

  async loadGame(gameId: string): Promise<GameState | null> {
    const rows = await this.db.select().from(games).where(eq(games.id, gameId));
    return rows.length ? (rows[0].state as GameState) : null;
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
}
