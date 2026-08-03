/**
 * Shared Express application for local and Vercel runtimes.
 *
 * Wires a GameRepository + interactive TurnApi + orchestrator into a small JSON
 * API, and serves a single-page board UI from /public. State persists by default
 * via embedded PGlite (a local file store), so games survive restarts; set
 * DATABASE_URL for a real Postgres, or EXRISK_MEMORY=1 for an ephemeral in-memory
 * store. Hot-seat: the UI acts as whichever player is at the front of the line.
 *
 * Local entry: src/server/local.ts. Vercel entry: src/server.ts.
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { InMemoryGameRepository, type GameRepository } from '../services/repository.js';
import { DrizzleGameRepository } from '../services/drizzleRepository.js';
import { createDb, type DbHandle } from '../../db/client.js';
import { TurnApi, TurnError } from '../services/turnApi.js';
import { openDailySession, handleWindowExpiry, systemClock } from '../services/orchestrator.js';
import { GameScheduler } from '../services/scheduling/gameScheduler.js';
import { InProcessJobQueue, PassiveJobQueue } from '../services/scheduling/jobQueue.js';
import { PgBossJobQueue } from '../services/scheduling/pgBossJobQueue.js';
import {
  isAuthorizedCronRequest,
  reconcileAllDue,
  reconcileGameDue,
} from '../services/scheduling/reconcile.js';
import { logExercise } from '../services/exerciseApi.js';
import { ensureTurnStarted } from '../services/turnStart.js';
import { buildPlayerDashboard } from '../services/playerDashboard.js';
import { buildSharedHealthProgress } from '../services/sharedHealthProgress.js';
import {
  deleteOwnChatMessage,
  reportChatMessage,
  sendGameChatMessage,
  setChatMuted,
} from '../services/gameChat.js';
import {
  submitLobbyHealthVotes,
  summarizeLobbyHealthVotes,
} from '../services/lobbyHealthVoting.js';
import { findActiveMultiplayerGame, isPracticeGame } from '../services/activeGame.js';
import { leaveGame, removeLobbyMember, startLobbyGame } from '../services/gameLifecycle.js';
import { listUserGames } from '../services/gameLibrary.js';
import { deleteAccount } from '../services/accountLifecycle.js';
import { executeIdempotent } from '../services/idempotency.js';
import { NotificationService } from '../services/notifications.js';
import {
  proposeHealthRules,
  voteOnHealthRules,
  withHealthRules,
  type HealthRulesInput,
} from '../services/healthRules.js';
import { signup, login, logout, resolveToken, type PublicUser } from '../services/authApi.js';
import { SESSION_TTL_MS } from '../services/authApi.js';
import { AuthRateLimiter } from '../services/authRateLimit.js';
import { claimSeat, claimAllSeats, claimOpenSeat, seatFor } from '../services/membership.js';
import {
  createGame,
  MAX_GAME_PLAYERS,
  MIN_GAME_PLAYERS,
} from '../engine/setup.js';
import { CONTINENTS, CONTINENT_OF, NEIGHBORS } from '../engine/map.js';
import { currentPlayer, type DailySession } from '../engine/turnSession.js';
import type { ReinforcePlacement } from '../engine/reinforce.js';
import type { GameConfig, GameState, HealthRuleGovernance, TerritoryId } from '../engine/types.js';

const PLAYER_COLORS = [
  '#e05c4b',
  '#4b8fe0',
  '#3fae7a',
  '#c98a2b',
  '#8a63d2',
  '#d0518f',
  '#2aa7b8',
  '#8aa43a',
  '#e07832',
  '#7a8da8',
];
const PRACTICE_WINDOW_MINUTES = 20;
const SUPPORTED_TIMEZONES = new Set([
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'UTC',
]);
const SESSION_COOKIE = 'exrisk_session';

// Assigned in main() before the server accepts requests.
let repo: GameRepository;
let api: TurnApi;
let scheduler: GameScheduler;
let database: DbHandle | null = null;
let durableSchedulerQueue: PgBossJobQueue | null = null;
let runtimeInitialization: Promise<void> | null = null;
let notifier: NotificationService;

class RuntimeInitializationError extends Error {
  constructor(cause: unknown) {
    super('The game service could not initialize.', { cause });
    this.name = 'RuntimeInitializationError';
  }
}

// Auto-resolution here uses the deterministic defensive fallback (a planner that
// throws) so the demo never needs API credits. Swap in createAiPlanner() to use
// the note-driven AI.
const throwingPlanner = async () => {
  throw new Error('AI planner disabled in demo');
};

// End-of-turn hook: the scheduler advances the line and arms the next player's
// window timer (or opens the next day).
async function onPlayerCompleted(gameId: string, dayNumber: number, playerId: string): Promise<void> {
  await scheduler.onPlayerCompleted(gameId, dayNumber, playerId);
  const game = await repo.loadGame(gameId);
  if (!game || game.practice) return;
  if (game.status === 'finished') {
    const winner = game.players.find((player) => player.id === game.winnerId)?.name ?? 'A player';
    await notifier.notifyGameMembers(gameId, {
      type: 'game_finished',
      title: 'Game finished',
      body: `${winner} won the game.`,
      deepLink: gameDeepLink(gameId),
    });
    return;
  }
  const session = await repo.loadSession(gameId, game.dayNumber);
  const nextPlayerId = session ? currentPlayer(session) : null;
  const owner = nextPlayerId ? await repo.getMemberBySeat(gameId, nextPlayerId) : null;
  if (owner) {
    await notifier.notifyUsers([owner.userId], {
      gameId,
      type: 'turn_started',
      title: 'Your move is ready',
      body: `Your HealthRisk turn is ready for Day ${game.dayNumber}.`,
      deepLink: gameDeepLink(gameId),
    });
  }
}

function publicAppUrl(): string {
  return String(process.env.PUBLIC_APP_URL ?? '').replace(/\/$/, '');
}

function gameDeepLink(gameId: string): string {
  const base = publicAppUrl();
  return base ? `${base}/game/${encodeURIComponent(gameId)}` : `/game/${encodeURIComponent(gameId)}`;
}

function inviteLink(gameId: string): string {
  const base = publicAppUrl();
  return base ? `${base}/join/${encodeURIComponent(gameId)}` : `/join/${encodeURIComponent(gameId)}`;
}


/** The active day + current actor for a game (hot-seat: actor = front of line). */
async function getActor(gameId: string): Promise<{ game: GameState; day: number; playerId: string | null }> {
  const game = await repo.loadGame(gameId);
  if (!game) throw new TurnError('no_game', 'Unknown game');
  const day = game.dayNumber;
  const session = await repo.loadSession(gameId, day);
  return { game, day, playerId: session ? currentPlayer(session) : null };
}

function healthLoggingSeat(
  game: GameState,
  session: DailySession | null,
  ownedSeats: string[],
): string | null {
  if (game.status !== 'active') return null;
  const eligibleSeats = ownedSeats.filter((seat) => {
    const status = game.players.find((player) => player.id === seat)?.status;
    return status === 'active' || status === 'auto_piloted';
  });
  if (!eligibleSeats.length) return null;
  const activeSeat = session ? currentPlayer(session) : null;
  return activeSeat && eligibleSeats.includes(activeSeat) ? activeSeat : eligibleSeats[0]!;
}

/** Serialize game state for the UI. `viewerId` marks which seat is "you". */
async function gameView(gameId: string, viewerId?: string) {
  let game = await repo.loadGame(gameId);
  if (!game) return null;
  let day0 = game.dayNumber;
  let session = await repo.loadSession(gameId, day0);
  let playerId = session ? currentPlayer(session) : null;

  // Starting the turn grants the current player their standard reinforcements.
  if (game.status === 'active' && playerId) {
    await repo.withGameLock(gameId, async () => {
      const lockedGame = await repo.loadGame(gameId);
      if (!lockedGame || lockedGame.status !== 'active') return;
      const lockedSession = await repo.loadSession(gameId, lockedGame.dayNumber);
      const lockedPlayerId = lockedSession ? currentPlayer(lockedSession) : null;
      if (lockedPlayerId) {
        await ensureTurnStarted(
          repo,
          gameId,
          lockedGame.dayNumber,
          lockedPlayerId,
        );
      }
    });
  }

  game = (await repo.loadGame(gameId))!;
  day0 = game.dayNumber;
  session = await repo.loadSession(gameId, day0);
  playerId = session ? currentPlayer(session) : null;
  const turnState = playerId ? await repo.loadTurnState(gameId, game.dayNumber, playerId) : null;
  const members = await repo.listMembers(gameId);
  const seatOwner = new Map(members.map((m) => [m.playerId, m.userId]));
  const mySeats = viewerId ? members.filter((m) => m.userId === viewerId).map((m) => m.playerId) : [];
  const yourTurn = !!playerId && mySeats.includes(playerId);
  const dashboardPlayerId = healthLoggingSeat(game, session, mySeats);
  const dashboardTurnState = dashboardPlayerId
    ? await repo.loadTurnState(gameId, game.dayNumber, dashboardPlayerId)
    : null;
  const dashboard = dashboardPlayerId
    ? await buildPlayerDashboard(repo, gameId, game.dayNumber, dashboardPlayerId, dashboardTurnState)
    : null;
  const sharedHealthProgress = mySeats.length
    ? await buildSharedHealthProgress(repo, gameId, game.dayNumber)
    : [];
  const sharedHealthByPlayer = new Map(
    sharedHealthProgress.map((progress) => [progress.playerId, progress]),
  );
  const practice = await isPracticeGame(repo, game);
  const mutedUserIds =
    viewerId && mySeats.length && !practice
      ? await repo.listMutedUserIds(gameId, viewerId)
      : [];
  const mutedUsers = new Set(mutedUserIds);
  const chatMessages =
    mySeats.length && !practice
      ? (await repo.listChatMessages(gameId, 50)).filter(
          (message) => !mutedUsers.has(message.userId),
        )
      : [];
  const lobbyParticipantIds = game.players
    .filter((player) => seatOwner.has(player.id))
    .map((player) => player.id);
  const visiblePlayers =
    game.status === 'setup' && !practice
      ? game.players.filter((player) => seatOwner.has(player.id))
      : game.players;
  const colorOf = new Map(
    visiblePlayers.map((player, index) => [
      player.id,
      PLAYER_COLORS[index % PLAYER_COLORS.length],
    ]),
  );
  const lobbyHealthVoteSummary = summarizeLobbyHealthVotes(game, lobbyParticipantIds);
  const myLobbyHealthSelections = [...new Set(
    mySeats.flatMap((playerId) => game.lobbyHealthVotes?.[playerId] ?? []),
  )];
  const scheduledPlayerWindowMinutes =
    game.status === 'setup' && !practice
      ? Math.floor((24 * 60) / Math.max(1, lobbyParticipantIds.length))
      : game.config.perPlayerWindowMinutes;
  const activeMultiplayerGameId = viewerId
    ? await findActiveMultiplayerGame(repo, viewerId)
    : null;
  const healthLoggingPlayer = dashboardPlayerId
    ? game.players.find((player) => player.id === dashboardPlayerId) ?? null
    : null;
  const healthLoggingAppliesTo =
    healthLoggingPlayer && playerId === healthLoggingPlayer.id
      ? turnState?.phase === 'reinforce'
        ? 'current_move'
        : 'next_move'
      : healthLoggingPlayer && session?.queue.includes(healthLoggingPlayer.id)
        ? 'upcoming_move'
        : 'next_move';
  const healthLoggingReason =
    game.status !== 'active'
      ? 'game_not_active'
      : mySeats.length && !healthLoggingPlayer
        ? 'out_of_game'
        : !mySeats.length
          ? 'no_seat'
          : null;

  return {
    id: game.id,
    revision: game.revision ?? 0,
    practice,
    activeMultiplayerGameId,
    status: game.status,
    winnerId: game.winnerId ?? null,
    events: game.events ?? [],
    dayNumber: game.dayNumber,
    turnOrder:
      game.status === 'setup' && !practice
        ? visiblePlayers.map((player) => player.id)
        : game.turnOrder,
    currentPlayerId: playerId,
    mySeats,
    isCreator: mySeats.includes(game.players[0]!.id),
    yourTurn,
    dashboard,
    healthLogging: {
      allowed: !!healthLoggingPlayer,
      playerId: healthLoggingPlayer?.id ?? null,
      playerName: healthLoggingPlayer?.name ?? null,
      appliesTo: healthLoggingPlayer ? healthLoggingAppliesTo : null,
      reason: healthLoggingReason,
    },
    phase: turnState?.phase ?? 'reinforce',
    startBonus: turnState?.startBonus ?? 0,
    startContinents: turnState?.startContinents ?? [],
    windowExpiresAt: session?.windowExpiresAt ?? null,
    nextSessionOpensAt: session?.nextSessionOpensAt ?? null,
    perPlayerWindowMinutes: scheduledPlayerWindowMinutes,
    schedule: {
      timezone: game.config.timezone,
      dailyStartMinuteOfDay: game.config.windowStartMinuteOfDay,
      playerWindowMinutes: scheduledPlayerWindowMinutes,
      moveDeadlineAt: session?.windowExpiresAt ?? null,
      nextSessionOpensAt: session?.nextSessionOpensAt ?? null,
      missedTurnPolicy: 'auto_resolve',
    },
    claimedPlayerCount: members.length,
    lobbyCapacity: game.status === 'setup' && !practice ? game.players.length : visiblePlayers.length,
    lobbyHealthVoting: {
      enabled: game.status === 'setup' && !practice,
      voteCounts: lobbyHealthVoteSummary.voteCounts,
      submittedPlayerIds: lobbyHealthVoteSummary.submittedPlayerIds,
      includedExerciseKeys: lobbyHealthVoteSummary.includedExerciseKeys,
      submissionCount: lobbyHealthVoteSummary.submittedPlayerIds.length,
      requiredSubmissions: lobbyParticipantIds.length,
      allSubmitted: lobbyHealthVoteSummary.allSubmitted,
      hasSubmitted:
        mySeats.length > 0 &&
        mySeats.every((playerId) =>
          Object.prototype.hasOwnProperty.call(game.lobbyHealthVotes ?? {}, playerId)),
      mySelections: myLobbyHealthSelections,
    },
    chatMessages,
    mutedUserIds,
    players: visiblePlayers.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      color: colorOf.get(p.id),
      pendingReinforcements: p.pendingReinforcements,
      pendingEliminationReward: p.pendingEliminationReward ?? 0,
      note: p.standingOrdersNote,
      claimed: seatOwner.has(p.id),
      healthProgress: sharedHealthByPlayer.get(p.id) ?? null,
    })),
    exercises: game.config.exercises.map((e) => ({
      key: e.key,
      label: e.label,
      unitLabel: e.unitLabel,
      category: e.category ?? 'movement',
      trackingType: e.trackingType ?? 'quantity',
      troopsPerUnit: e.troopsPerUnit,
      dailyUnitCap: e.dailyUnitCap,
    })),
    categoryTroopCaps: game.config.categoryTroopCaps ?? {},
    healthRuleGovernance: game.config.healthRuleGovernance ?? 'creator',
    healthRulesVersion: game.healthRulesVersion ?? 1,
    pendingHealthRuleProposal: game.pendingHealthRuleProposal ?? null,
    dailyTotalTroopCap: game.config.dailyTotalTroopCap,
    continents: CONTINENTS.map((c) => ({ id: c.id, label: c.label, bonus: c.bonus })),
    territories:
      game.status === 'setup' && !practice
        ? []
        : game.territories.map((t) => ({
          id: t.id,
          owner: t.owner,
          armies: t.armies,
          continent: CONTINENT_OF[t.id],
          neighbors: NEIGHBORS[t.id],
          color: t.owner ? colorOf.get(t.owner) : '#9aa0a6',
        })),
  };
}

const app = express();
if (process.env.TRUST_PROXY === '1' || process.env.VERCEL === '1') {
  app.set('trust proxy', 1);
}
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  const requestId = req.header('x-request-id')?.slice(0, 128) || randomUUID();
  (req as express.Request & { requestId: string }).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
});

// Vercel imports the app without running a permanent listener. Initialize the
// database and request services lazily, once per warm function instance.
app.use('/api', (_req, _res, next) => {
  initializeRuntime().then(
    () => next(),
    (error: unknown) => next(new RuntimeInitializationError(error)),
  );
});

/** Load-balancer/readiness probe. Never returns credentials or game data. */
app.get('/api/health', async (_req, res) => {
  try {
    if (database) await database.check();
    res.json({
      status: 'ok',
      storage: database?.kind ?? 'memory',
      persistent: database?.persistent ?? false,
      schemaVersion: database?.migrationVersion ?? null,
    });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});

function bearer(req: express.Request): string | undefined {
  const h = req.header('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

function cookieSession(req: express.Request): string | undefined {
  const cookie = req.header('cookie');
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE) return value.join('=') || undefined;
  }
  return undefined;
}

function sessionToken(req: express.Request): string | undefined {
  return bearer(req) ?? cookieSession(req);
}

function setSessionCookie(res: express.Response, token: string): void {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res: express.Response): void {
  const parts = [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

const authRateLimiter = new AuthRateLimiter();

function consumeAuthAttempt(
  req: express.Request,
  res: express.Response,
  action: 'login' | 'signup',
): string {
  const key = `${action}:${req.ip}`;
  const limit = authRateLimiter.consume(key);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    throw new TurnError(
      'auth_rate_limited',
      'Too many attempts. Please wait before trying again.',
    );
  }
  return key;
}

// Resolve the bearer token to a user (best-effort) on every request.
app.use((req, _res, next) => {
  resolveToken(repo, sessionToken(req))
    .then((user) => {
      (req as express.Request & { user: PublicUser | null }).user = user;
      next();
    })
    .catch(next);
});

function currentUser(req: express.Request): PublicUser | null {
  return (req as express.Request & { user: PublicUser | null }).user ?? null;
}
function requireUser(req: express.Request): PublicUser {
  const u = currentUser(req);
  if (!u) throw new TurnError('unauthorized', 'Please log in');
  return u;
}

function reinforcementPlacements(value: unknown): ReinforcePlacement[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TurnError('bad_placements', 'Provide at least one reinforcement placement');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new TurnError('bad_placements', 'Each reinforcement placement needs a territory and count');
    }
    const placement = entry as Record<string, unknown>;
    if (
      typeof placement.territoryId !== 'string' ||
      placement.territoryId.length === 0 ||
      !Number.isSafeInteger(placement.count) ||
      Number(placement.count) <= 0
    ) {
      throw new TurnError(
        'bad_placements',
        'Each reinforcement placement needs a territory and a positive whole-number count',
      );
    }
    return {
      territoryId: placement.territoryId as TerritoryId,
      count: Number(placement.count),
    };
  });
}

/**
 * The seat to act on: the current front-of-line seat, which the authenticated
 * user must own. Works for normal play (you own one seat, act when it's up) and
 * practice (you own every seat, act every turn).
 */
async function actingSeat(req: express.Request, gameId: string): Promise<{ day: number; playerId: string }> {
  const user = requireUser(req);
  const game = await repo.loadGame(gameId);
  if (!game) throw new TurnError('no_game', 'Unknown game');
  const session = await repo.loadSession(gameId, game.dayNumber);
  const currentSeat = session ? currentPlayer(session) : null;
  if (!currentSeat) throw new TurnError('no_turn', 'No active turn');
  const owner = await repo.getMemberBySeat(gameId, currentSeat);
  if (!owner || owner.userId !== user.id) throw new TurnError('not_your_turn', 'It is not your turn');
  return { day: game.dayNumber, playerId: currentSeat };
}

function requestId(req: express.Request): string {
  return (req as express.Request & { requestId?: string }).requestId ?? 'unknown';
}

async function respondIdempotently<T>(
  req: express.Request,
  res: express.Response,
  scope: string,
  action: () => Promise<{ status: number; body: T }>,
): Promise<void> {
  const user = requireUser(req);
  const result = await executeIdempotent(
    repo,
    {
      userId: user.id,
      scope,
      key: req.header('idempotency-key') ?? undefined,
      payload: req.body ?? null,
    },
    action,
  );
  if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
  res.status(result.status).json(result.body);
}

/**
 * Health progress belongs to the signed-in user's eligible seat, regardless of
 * whose move is open. Practice users own every seat, so their current seat is
 * preferred while a move is in progress.
 */
async function healthSeat(req: express.Request, gameId: string): Promise<{ day: number; playerId: string }> {
  const user = requireUser(req);
  const game = await repo.loadGame(gameId);
  if (!game) throw new TurnError('no_game', 'Unknown game');
  if (game.status !== 'active') {
    throw new TurnError('game_not_active', 'Health progress can be logged after the game starts');
  }
  const members = await repo.listMembers(gameId);
  const ownedSeats = members
    .filter((member) => member.userId === user.id)
    .map((member) => member.playerId);
  if (!ownedSeats.length) throw new TurnError('no_seat', 'Join this game before logging health progress');
  const session = await repo.loadSession(gameId, game.dayNumber);
  const playerId = healthLoggingSeat(game, session, ownedSeats);
  if (!playerId) {
    throw new TurnError('not_active_player', 'Players who are out of the game cannot earn troops');
  }
  return { day: game.dayNumber, playerId };
}

async function mutateGame<T>(
  req: express.Request,
  gameId: string,
  action: () => Promise<T>,
  requireRevision = true,
): Promise<T> {
  requireUser(req);
  await reconcileGameDue({ repo, planner: throwingPlanner }, gameId);
  return repo.withGameLock(gameId, async () => {
    const before = await repo.loadGame(gameId);
    if (!before) throw new TurnError('no_game', 'Unknown game');
    const actualRevision = before.revision ?? 0;
    const expectedRevision = Number(req.body?.revision);
    if (
      requireRevision &&
      (!Number.isInteger(expectedRevision) || expectedRevision !== actualRevision)
    ) {
      throw new TurnError(
        'stale_game',
        'This game changed in another browser. The latest state has been loaded; please try again.',
      );
    }

    const result = await action();
    const after = await repo.loadGame(gameId);
    if (after) await repo.saveGame({ ...after, revision: actualRevision + 1 });
    return result;
  });
}

const asyncH =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) => {
    fn(req, res).catch((err) => {
      if (err instanceof TurnError) {
        const status = apiStatus(err.code);
        res.status(status).json({
          error: err.code,
          message: err.message,
          requestId: requestId(req),
          retryable:
            err.code === 'auth_rate_limited' ||
            err.code === 'chat_rate_limited' ||
            err.code === 'idempotency_in_progress',
        });
      } else {
        console.error(err);
        res.status(500).json({
          error: 'internal',
          message: 'The request failed.',
          requestId: requestId(req),
          retryable: true,
        });
      }
    });
  };

function apiStatus(code: string): number {
  if (code === 'unauthorized' || code === 'bad_credentials') return 401;
  if (
    code === 'no_seat' ||
    code === 'not_creator' ||
    code === 'not_message_owner'
  ) return 403;
  if (code === 'no_game' || code === 'no_message') return 404;
  if (code === 'auth_rate_limited' || code === 'chat_rate_limited') return 429;
  if (
    code === 'not_your_turn' ||
    code === 'stale_game' ||
    code === 'active_multiplayer_game' ||
    code === 'game_started' ||
    code === 'idempotency_conflict' ||
    code === 'idempotency_in_progress'
  ) return 409;
  return 400;
}

/**
 * Vercel Cron sends CRON_SECRET as a Bearer credential. This route deliberately
 * fails closed when the secret is not configured.
 */
app.get(
  '/api/cron/reconcile',
  asyncH(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (
      !isAuthorizedCronRequest(
        req.header('authorization'),
        process.env.CRON_SECRET,
      )
    ) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'A valid cron credential is required.',
        requestId: requestId(req),
        retryable: false,
      });
      return;
    }
    const result = await reconcileAllDue({
      repo,
      planner: throwingPlanner,
      maxSteps: 20,
    });
    res.json({
      ok: true,
      ...result,
      checkedAt: new Date().toISOString(),
    });
  }),
);

// --- Auth ---
app.post(
  '/api/auth/signup',
  asyncH(async (req, res) => {
    const rateKey = consumeAuthAttempt(req, res, 'signup');
    const result = await signup(
      repo,
      String(req.body?.username ?? ''),
      String(req.body?.password ?? ''),
    );
    authRateLimiter.reset(rateKey);
    setSessionCookie(res, result.token);
    res.json(result);
  }),
);
app.post(
  '/api/auth/login',
  asyncH(async (req, res) => {
    const rateKey = consumeAuthAttempt(req, res, 'login');
    const result = await login(
      repo,
      String(req.body?.username ?? ''),
      String(req.body?.password ?? ''),
    );
    authRateLimiter.reset(rateKey);
    setSessionCookie(res, result.token);
    res.json(result);
  }),
);
app.post(
  '/api/auth/logout',
  asyncH(async (req, res) => {
    await logout(repo, sessionToken(req));
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);
app.get(
  '/api/auth/me',
  asyncH(async (req, res) => {
    const user = currentUser(req);
    res.json({
      user,
      activeMultiplayerGameId: user ? await findActiveMultiplayerGame(repo, user.id) : null,
    });
  }),
);

app.delete(
  '/api/account',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    await deleteAccount(repo, user.id, String(req.body?.password ?? ''));
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

app.get(
  '/api/meta',
  asyncH(async (_req, res) => {
    res.json({
      apiVersion: 1,
      minimumIosApiVersion: 1,
      openApiUrl: '/openapi.json',
      capabilities: {
        idempotency: true,
        notifications: true,
        apnsConfigured: notifier.pushConfigured,
        universalInvites: true,
        chatSafety: true,
      },
    });
  }),
);

app.get(
  '/api/games',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const games = await listUserGames(repo, user.id);
    res.json({
      games: games.map((game) => ({
        ...game,
        inviteLink: game.status === 'setup' && !game.practice ? inviteLink(game.id) : null,
        deepLink: gameDeepLink(game.id),
      })),
    });
  }),
);

app.get(
  '/api/devices',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const devices = await repo.listDeviceRegistrations(user.id);
    res.json({ devices: devices.map(publicDeviceRegistration) });
  }),
);

app.post(
  '/api/devices',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const device = await notifier.registerIosDevice(user.id, req.body ?? {});
    res.status(201).json({ device: publicDeviceRegistration(device) });
  }),
);

app.delete(
  '/api/devices/:id',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    await repo.deleteDeviceRegistration(String(req.params.id), user.id);
    res.json({ ok: true });
  }),
);

app.get(
  '/api/notifications',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const limit = Number(req.query.limit ?? 50);
    const notifications = await repo.listNotifications(user.id, limit);
    res.json({
      notifications,
      unreadCount: notifications.filter((notification) => !notification.readAt).length,
    });
  }),
);

app.post(
  '/api/notifications/:id/read',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    await repo.markNotificationRead(String(req.params.id), user.id, new Date().toISOString());
    res.json({ ok: true });
  }),
);

function publicDeviceRegistration(device: {
  id: string;
  platform: string;
  environment: string;
  token: string;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: device.id,
    platform: device.platform,
    environment: device.environment,
    tokenSuffix: device.token.slice(-6),
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
  };
}

/**
 * Create a game. Multiplayer opens the engine's maximum number of join slots
 * but exposes only the people who actually join; practice keeps an explicit
 * seat count within the same supported range.
 */
app.post(
  '/api/games',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    await respondIdempotently(req, res, 'games:create', async () => {
    const practice = Boolean(req.body?.practice);
    const count = practice
      ? Math.min(
          Math.max(Number(req.body?.players ?? MIN_GAME_PLAYERS), MIN_GAME_PLAYERS),
          MAX_GAME_PLAYERS,
        )
      : MAX_GAME_PLAYERS;
    if (!practice) {
      const activeGameId = await findActiveMultiplayerGame(repo, user.id);
      if (activeGameId) {
        throw new TurnError(
          'active_multiplayer_game',
          `You are already playing an active multiplayer game (${activeGameId})`,
        );
      }
    }
    const players = Array.from({ length: count }, (_, i) => ({
      id: `p${i + 1}`,
      name: !practice && i === 0 ? user.username : `Player ${i + 1}`,
    }));
    const id = `game-${Math.random().toString(36).slice(2, 8)}`;
    let config = demoConfig();
    if (req.body?.healthRules) {
      try {
        config = withHealthRules(config, req.body.healthRules as HealthRulesInput);
      } catch (error) {
        throw new TurnError('bad_health_rules', (error as Error).message);
      }
    }
    const governance: HealthRuleGovernance = req.body?.healthRuleGovernance === 'vote' ? 'vote' : 'creator';
    const requestedStartMinute = Number(req.body?.dailyStartMinuteOfDay);
    const requestedTimezone = String(req.body?.timezone ?? '');
    config = {
      ...config,
      healthRuleGovernance: governance,
      windowStartMinuteOfDay:
        Number.isInteger(requestedStartMinute) &&
        requestedStartMinute >= 0 &&
        requestedStartMinute < 24 * 60
          ? requestedStartMinute
          : config.windowStartMinuteOfDay,
      timezone: SUPPORTED_TIMEZONES.has(requestedTimezone)
        ? requestedTimezone
        : config.timezone,
    };
    const game = createGame({ id, config, players, seed: (Math.random() * 2 ** 31) | 0 });
    game.practice = practice;
    game.status = practice ? 'active' : 'setup';
    game.healthRulesVersion = 1;
    if (!practice) game.lobbyHealthVotes = {};
    await repo.withGameLock(id, async () => {
      await repo.saveGame(game);

      if (practice) await claimAllSeats(repo, id, players.map((p) => p.id), user.id);
      else await claimSeat(repo, id, 'p1', user.id);

      if (practice) {
        await openDailySession(repo, id, 0);
        await scheduler.armNextWindow(id, 0);
      }
    });
    return { status: 201, body: await gameView(id, user.id) };
    });
  }),
);

app.post(
  '/api/games/:id/start',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const id = req.params.id as string;
    await respondIdempotently(req, res, `game:${id}:start`, async () => {
      await mutateGame(req, id, async () => {
        await startLobbyGame(repo, id, user.id);
        await openDailySession(repo, id, 0);
        await scheduler.armNextWindow(id, 0);
      });
      await notifier.notifyGameMembers(id, {
        type: 'game_started',
        title: 'The game has started',
        body: 'The board is ready. Open HealthRisk to see the first move.',
        deepLink: gameDeepLink(id),
        senderUserId: user.id,
      });
      const view = await gameView(id, user.id);
      const owner = view?.currentPlayerId
        ? await repo.getMemberBySeat(id, view.currentPlayerId)
        : null;
      if (owner && owner.userId !== user.id) {
        await notifier.notifyUsers([owner.userId], {
          gameId: id,
          type: 'turn_started',
          title: 'Your first move is ready',
          body: view?.windowExpiresAt
            ? `Your move is open until ${view.windowExpiresAt}.`
            : 'Your move is ready.',
          deepLink: gameDeepLink(id),
        });
      }
      return { status: 200, body: { game: view } };
    });
  }),
);

app.post(
  '/api/games/:id/leave',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const id = req.params.id as string;
    await respondIdempotently(req, res, `game:${id}:leave`, async () => {
      await mutateGame(req, id, async () => {
        const before = await getActor(id);
        const result = await leaveGame(repo, id, user.id);
        if (
          result.game.status === 'active' &&
          result.session &&
          currentPlayer(result.session) !== before.playerId
        ) {
          await scheduler.armNextWindow(id, result.game.dayNumber);
        }
      });
      await notifier.notifyGameMembers(id, {
        type: 'lobby_removed',
        title: 'Player left',
        body: `${user.username} left the game.`,
        deepLink: gameDeepLink(id),
        senderUserId: user.id,
      });
      return {
        status: 200,
        body: {
          ok: true as const,
          activeMultiplayerGameId: await findActiveMultiplayerGame(repo, user.id),
          game: await gameView(id, user.id),
        },
      };
    });
  }),
);

app.delete(
  '/api/games/:id/members/:playerId',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const id = String(req.params.id);
    const playerId = String(req.params.playerId);
    const removedMember = await repo.getMemberBySeat(id, playerId);
    await respondIdempotently(req, res, `game:${id}:remove:${playerId}`, async () => {
      await mutateGame(req, id, async () => {
        await removeLobbyMember(repo, id, user.id, playerId);
      });
      if (removedMember) {
        await notifier.notifyUsers([removedMember.userId], {
          gameId: id,
          type: 'lobby_removed',
          title: 'Removed from lobby',
          body: 'The game creator removed you from the waiting room.',
          deepLink: inviteLink(id),
        });
      }
      return { status: 200, body: { game: await gameView(id, user.id) } };
    });
  }),
);

app.post(
  '/api/games/:id/health-rules/propose',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const id = req.params.id as string;
    const game = await repo.loadGame(id);
    if (!game) throw new TurnError('no_game', 'Unknown game');
    const creatorSeat = game.players[0]!.id;
    const creator = await repo.getMemberBySeat(id, creatorSeat);
    if (!creator || creator.userId !== user.id) {
      throw new TurnError('not_creator', 'Only the game creator can propose health-rule changes');
    }
    await respondIdempotently(req, res, `game:${id}:health-rules:propose`, async () => {
      await mutateGame(req, id, async () => {
        try {
          await proposeHealthRules(repo, id, creatorSeat, req.body as HealthRulesInput);
        } catch (error) {
          throw new TurnError('bad_health_rules', (error as Error).message);
        }
      });
      return { status: 200, body: { game: await gameView(id, user.id) } };
    });
  }),
);

app.post(
  '/api/games/:id/health-rules/vote',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const id = req.params.id as string;
    const members = await repo.listMembers(id);
    const mySeats = members.filter((member) => member.userId === user.id).map((member) => member.playerId);
    if (!mySeats.length) throw new TurnError('no_seat', 'Join this game before voting');
    await respondIdempotently(req, res, `game:${id}:health-rules:vote`, async () => {
      await mutateGame(req, id, async () => {
        for (const playerId of mySeats) {
          const latest = await repo.loadGame(id);
          if (latest?.pendingHealthRuleProposal?.status !== 'pending') break;
          await voteOnHealthRules(repo, id, playerId, Boolean(req.body?.approve));
        }
      });
      return { status: 200, body: { game: await gameView(id, user.id) } };
    });
  }),
);

/** Join an existing game — claims the next open seat (idempotent per user). */
app.post(
  '/api/games/:id/join',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const gameId = req.params.id as string;
    const game = await repo.loadGame(gameId);
    if (!game) throw new TurnError('no_game', 'Unknown game');
    const existing = await repo.getMemberByUser(gameId, user.id);
    if (!existing && game.status !== 'setup') {
      throw new TurnError('game_started', 'This game has already started');
    }
    await respondIdempotently(req, res, `game:${gameId}:join`, async () => {
      let seat = existing?.playerId ?? '';
      await mutateGame(req, gameId, async () => {
        const latest = (await repo.loadGame(gameId))!;
        const activeGameId = await findActiveMultiplayerGame(repo, user.id);
        if (!(await isPracticeGame(repo, latest)) && activeGameId && activeGameId !== gameId) {
          throw new TurnError(
            'active_multiplayer_game',
            `You are already playing an active multiplayer game (${activeGameId})`,
          );
        }
        seat = await claimOpenSeat(repo, gameId, latest.players.map((p) => p.id), user.id);
        const lobbyHealthVotes = { ...(latest.lobbyHealthVotes ?? {}) };
        if (!existing) delete lobbyHealthVotes[seat];
        await repo.saveGame({
          ...latest,
          lobbyHealthVotes,
          players: latest.players.map((player) =>
            player.id === seat ? { ...player, name: user.username } : player,
          ),
        });
      }, false);
      if (!existing) {
        await notifier.notifyGameMembers(gameId, {
          type: 'lobby_joined',
          title: 'A player joined',
          body: `${user.username} joined the waiting room.`,
          deepLink: inviteLink(gameId),
          senderUserId: user.id,
        });
      }
      return {
        status: 200,
        body: { seat, game: await gameView(gameId, user.id) },
      };
    });
  }),
);

app.post(
  '/api/games/:id/lobby-health-votes',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const id = req.params.id as string;
    const members = await repo.listMembers(id);
    const mySeats = members
      .filter((member) => member.userId === user.id)
      .map((member) => member.playerId);
    if (!mySeats.length) throw new TurnError('no_seat', 'Join this lobby before selecting health goals');
    if (!Array.isArray(req.body?.exerciseKeys)) {
      throw new TurnError('bad_health_vote', 'Submit a list of selected health goals');
    }
    const exerciseKeys = req.body.exerciseKeys.map((value: unknown) => String(value));
    await respondIdempotently(req, res, `game:${id}:lobby-health-votes`, async () => {
      await mutateGame(req, id, async () => {
        for (const playerId of mySeats) {
          await submitLobbyHealthVotes(repo, id, playerId, exerciseKeys);
        }
      });
      return { status: 200, body: { game: await gameView(id, user.id) } };
    });
  }),
);

app.get(
  '/api/games/:id',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const id = req.params.id as string;
    if (!(await repo.loadGame(id))) throw new TurnError('no_game', 'Unknown game');
    if (!(await seatFor(repo, id, user.id))) {
      throw new TurnError('no_seat', 'Join this game before viewing it');
    }
    await reconcileGameDue({ repo, planner: throwingPlanner }, id);
    const view = await gameView(id, user.id);
    if (!view) throw new TurnError('no_game', 'Unknown game');
    res.json(view);
  }),
);

app.post(
  '/api/games/:id/chat',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const id = req.params.id as string;
    await respondIdempotently(req, res, `game:${id}:chat`, async () => {
      const message = await sendGameChatMessage(repo, id, user, req.body?.body);
      await notifier.notifyGameMembers(id, {
        type: 'chat_message',
        title: user.username,
        body: message.body.length > 120 ? `${message.body.slice(0, 117)}…` : message.body,
        deepLink: gameDeepLink(id),
        senderUserId: user.id,
      });
      return { status: 201, body: { message } };
    });
  }),
);

app.delete(
  '/api/games/:id/chat/:messageId',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const id = String(req.params.id);
    const messageId = String(req.params.messageId);
    await respondIdempotently(req, res, `game:${id}:chat:delete:${messageId}`, async () => {
      await deleteOwnChatMessage(repo, id, messageId, user.id);
      return { status: 200, body: { ok: true as const } };
    });
  }),
);

app.post(
  '/api/games/:id/chat/mutes',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const id = String(req.params.id);
    const mutedUserId = String(req.body?.userId ?? '');
    await setChatMuted(repo, id, user.id, mutedUserId, true);
    res.json({ ok: true, mutedUserIds: await repo.listMutedUserIds(id, user.id) });
  }),
);

app.delete(
  '/api/games/:id/chat/mutes/:userId',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const id = String(req.params.id);
    await setChatMuted(repo, id, user.id, String(req.params.userId), false);
    res.json({ ok: true, mutedUserIds: await repo.listMutedUserIds(id, user.id) });
  }),
);

app.post(
  '/api/games/:id/chat/:messageId/report',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const id = String(req.params.id);
    const messageId = String(req.params.messageId);
    await respondIdempotently(req, res, `game:${id}:chat:report:${messageId}`, async () => {
      const reportId = await reportChatMessage(
        repo,
        id,
        messageId,
        user.id,
        req.body?.reason,
      );
      return { status: 201, body: { ok: true as const, reportId } };
    });
  }),
);

app.post(
  '/api/games/:id/reinforce',
  asyncH(async (req, res) => {
    const id = req.params.id as string;
    const placements = reinforcementPlacements(req.body?.placements);
    await respondIdempotently(req, res, `game:${id}:reinforce`, async () => {
      const out = await mutateGame(req, id, async () => {
        const { day, playerId } = await actingSeat(req, id);
        return api.placeReinforcements(id, day, playerId, placements);
      });
      return { status: 200, body: { ...out, game: await gameView(id, currentUser(req)?.id) } };
    });
  }),
);

app.post(
  '/api/games/:id/cards/trade',
  asyncH(async (req, res) => {
    const id = req.params.id as string;
    await respondIdempotently(req, res, `game:${id}:cards:trade`, async () => {
      const out = await mutateGame(req, id, async () => {
        const { day, playerId } = await actingSeat(req, id);
        return api.tradeCards(id, day, playerId);
      });
      return { status: 200, body: { ...out, game: await gameView(id, currentUser(req)?.id) } };
    });
  }),
);

app.post(
  '/api/games/:id/attack',
  asyncH(async (req, res) => {
    const id = req.params.id as string;
    await respondIdempotently(req, res, `game:${id}:attack`, async () => {
      const result = await mutateGame(req, id, async () => {
        const { day, playerId } = await actingSeat(req, id);
        return api.attack(id, day, playerId, req.body);
      });
      return { status: 200, body: { result, game: await gameView(id, currentUser(req)?.id) } };
    });
  }),
);

app.post(
  '/api/games/:id/fortify',
  asyncH(async (req, res) => {
    const id = req.params.id as string;
    await respondIdempotently(req, res, `game:${id}:fortify`, async () => {
      await mutateGame(req, id, async () => {
        const { day, playerId } = await actingSeat(req, id);
        await api.fortify(id, day, playerId, req.body);
      });
      return { status: 200, body: { game: await gameView(id, currentUser(req)?.id) } };
    });
  }),
);

app.post(
  '/api/games/:id/end',
  asyncH(async (req, res) => {
    const id = req.params.id as string;
    await respondIdempotently(req, res, `game:${id}:end`, async () => {
      const out = await mutateGame(req, id, async () => {
        const { day, playerId } = await actingSeat(req, id);
        return api.endTurn(id, day, playerId);
      });
      return { status: 200, body: { ...out, game: await gameView(id, currentUser(req)?.id) } };
    });
  }),
);

/** Log exercise for your own seat, banking troops (§3). */
app.post(
  '/api/games/:id/exercise',
  asyncH(async (req, res) => {
    const id = req.params.id as string;
    await respondIdempotently(req, res, `game:${id}:exercise`, async () => {
      const out = await mutateGame(req, id, async () => {
        const { day, playerId } = await healthSeat(req, id);
        return logExercise(repo, id, day, playerId, {
          exerciseKey: String(req.body.exerciseKey),
          units: Number(req.body.units),
        });
      });
      return { status: 200, body: { ...out, game: await gameView(id, currentUser(req)?.id) } };
    });
  }),
);

/** Dev: let the current player auto-resolve their own turn. */
app.post(
  '/api/games/:id/expire',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const id = req.params.id as string;
    await respondIdempotently(req, res, `game:${id}:expire`, async () => {
      await mutateGame(req, id, async () => {
        const { day } = await actingSeat(req, id);
        await handleWindowExpiry(repo, throwingPlanner, id, day);
        await scheduler.armNextWindow(id, day);
      });
      return { status: 200, body: { game: await gameView(id, user.id) } };
    });
  }),
);

function demoConfig(): GameConfig {
  return {
    exercises: [
      {
        key: 'running',
        label: 'Running',
        unitLabel: 'mile',
        category: 'movement',
        trackingType: 'quantity',
        troopsPerUnit: 1,
        dailyUnitCap: 5,
      },
      {
        key: 'cycling',
        label: 'Cycling',
        unitLabel: 'mile',
        category: 'movement',
        trackingType: 'quantity',
        troopsPerUnit: 0.25,
        dailyUnitCap: 40,
      },
      {
        key: 'lifting',
        label: 'Weightlifting',
        unitLabel: 'min',
        category: 'movement',
        trackingType: 'duration',
        troopsPerUnit: 1 / 30,
        dailyUnitCap: 90,
      },
      {
        key: 'vegetables',
        label: 'Vegetable goal',
        unitLabel: 'completion',
        category: 'nutrition',
        trackingType: 'checkbox',
        troopsPerUnit: 1,
        dailyUnitCap: 1,
      },
      {
        key: 'balanced-meals',
        label: 'Balanced meals',
        unitLabel: 'completion',
        category: 'nutrition',
        trackingType: 'checkbox',
        troopsPerUnit: 1,
        dailyUnitCap: 1,
      },
      {
        key: 'sleep',
        label: 'Sleep goal',
        unitLabel: 'completion',
        category: 'recovery',
        trackingType: 'checkbox',
        troopsPerUnit: 1,
        dailyUnitCap: 1,
      },
    ],
    categoryTroopCaps: { movement: 6, nutrition: 2, recovery: 1 },
    healthRuleGovernance: 'creator',
    dailyTotalTroopCap: 8,
    windowStartMinuteOfDay: 19 * 60,
    // Practice remains quick; multiplayer replaces this at lobby start with an
    // equal share of the 24-hour game day.
    perPlayerWindowMinutes: Math.max(
      PRACTICE_WINDOW_MINUTES,
      Number(process.env.EXRISK_WINDOW_MIN ?? PRACTICE_WINDOW_MINUTES) || PRACTICE_WINDOW_MINUTES,
    ),
    autoForfeitAfterDays: null,
    autoAttackStopLoss: 3,
    maxAttacksPerTurn: null,
    timezone: 'America/Los_Angeles',
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
app.get(
  ['/.well-known/apple-app-site-association', '/apple-app-site-association'],
  (_req, res) => {
    const teamId = process.env.APPLE_TEAM_ID;
    const bundleId = process.env.IOS_BUNDLE_ID;
    const appId = teamId && bundleId ? `${teamId}.${bundleId}` : null;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      applinks: {
        apps: [],
        details: appId
          ? [{
              appIDs: [appId],
              components: [
                { '/': '/join/*', comment: 'HealthRisk multiplayer invitations' },
                { '/': '/game/*', comment: 'Open an existing HealthRisk game' },
              ],
            }]
          : [],
      },
      webcredentials: { apps: appId ? [appId] : [] },
    });
  },
);
app.use(express.static(path.join(here, '../../public')));
app.get(['/join/:gameId', '/game/:gameId'], (_req, res) => {
  res.sendFile(path.join(here, '../../public/index.html'));
});

// Make startup failures explicit JSON instead of Express's default HTML page.
app.use(
  (
    error: unknown,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const httpError = error as { status?: unknown; statusCode?: unknown; type?: unknown };
    const status =
      typeof httpError.status === 'number'
        ? httpError.status
        : typeof httpError.statusCode === 'number'
          ? httpError.statusCode
          : null;

    if (status === 400 || httpError.type === 'entity.parse.failed') {
      res.status(400).json({
        error: 'invalid_json',
        message: 'The request body must contain valid JSON.',
        requestId: requestId(req),
        retryable: false,
      });
      return;
    }

    console.error('Request failed:', error);
    if (error instanceof RuntimeInitializationError) {
      res.status(503).json({
        error: 'service_unavailable',
        message: error.message,
        requestId: requestId(req),
        retryable: true,
      });
      return;
    }
    if (req.path.startsWith('/api/')) {
      res.status(500).json({
        error: 'internal',
        message: 'The request failed.',
        requestId: requestId(req),
        retryable: true,
      });
      return;
    }
    res.status(500).send('The request failed.');
  },
);

function initializeRuntime(): Promise<void> {
  if (!runtimeInitialization) {
    runtimeInitialization = initializeRuntimeOnce().catch((error) => {
      runtimeInitialization = null;
      throw error;
    });
  }
  return runtimeInitialization;
}

async function initializeRuntimeOnce(): Promise<void> {
  if (process.env.EXRISK_MEMORY) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('EXRISK_MEMORY cannot be used when NODE_ENV=production');
    }
    repo = new InMemoryGameRepository();
    console.log('Store: in-memory (ephemeral)');
  } else {
    database = await createDb();
    repo = new DrizzleGameRepository(database.db, database.withGameLock);
    console.log(
      `Store: ${database.kind} @ ${database.location} (schema v${database.migrationVersion}, ${database.persistent ? 'persistent' : 'ephemeral'})`,
    );
  }
  notifier = new NotificationService(repo);
  api = new TurnApi({ repo, onPlayerCompleted });

  const isVercel = process.env.VERCEL === '1';
  const durableQueueUrl =
    process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

  // A permanent local process can own pg-boss workers. Vercel functions cannot,
  // so browser requests and the authenticated cron route reconcile persisted
  // deadlines through a passive scheduling boundary.
  const queue =
    isVercel
      ? new PassiveJobQueue()
      : database?.kind === 'postgres' && durableQueueUrl
        ? (durableSchedulerQueue = new PgBossJobQueue(durableQueueUrl))
        : new InProcessJobQueue();
  scheduler = new GameScheduler({
    repo,
    planner: throwingPlanner,
    queue,
    clock: systemClock,
  });
  scheduler.register();
  if (durableSchedulerQueue) {
    await durableSchedulerQueue.start();
    console.log('Turn scheduler: pg-boss (durable)');
  } else if (isVercel) {
    console.log('Turn scheduler: passive serverless boundary');
  } else {
    console.log('Turn scheduler: in-process (startup recovery enabled)');
  }

  if (!isVercel) {
    const recoveredGames = await scheduler.recoverActiveGames();
    if (recoveredGames) {
      console.log(`Turn scheduler: restored ${recoveredGames} active game(s)`);
    }
  }
}

export async function startLocalServer(): Promise<void> {
  await initializeRuntime();
  const port = Number(process.env.PORT ?? 3000);
  const httpServer = app.listen(port, () => {
    console.log(`Exercise Risk demo running at http://localhost:${port}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal}: closing Exercise Risk`);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await durableSchedulerQueue?.stop();
    await database?.close();
  };
  process.once('SIGINT', () => {
    shutdown('SIGINT').finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM').finally(() => process.exit(0));
  });
}

export default app;
