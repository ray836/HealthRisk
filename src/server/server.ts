/**
 * Local HTTP server for playing/testing Exercise Risk.
 *
 * Wires a GameRepository + interactive TurnApi + orchestrator into a small JSON
 * API, and serves a single-page board UI from /public. State persists by default
 * via embedded PGlite (a local file store), so games survive restarts; set
 * DATABASE_URL for a real Postgres, or EXRISK_MEMORY=1 for an ephemeral in-memory
 * store. Hot-seat: the UI acts as whichever player is at the front of the line.
 *
 * Run:  npx tsx src/server/server.ts   (or: npm run serve)
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { InMemoryGameRepository, type GameRepository } from '../services/repository.js';
import { DrizzleGameRepository } from '../services/drizzleRepository.js';
import { createDb, type DbHandle } from '../../db/client.js';
import { TurnApi, TurnError } from '../services/turnApi.js';
import { openDailySession, handleWindowExpiry, systemClock } from '../services/orchestrator.js';
import { GameScheduler } from '../services/scheduling/gameScheduler.js';
import { InProcessJobQueue } from '../services/scheduling/jobQueue.js';
import { PgBossJobQueue } from '../services/scheduling/pgBossJobQueue.js';
import { logExercise } from '../services/exerciseApi.js';
import { ensureTurnStarted } from '../services/turnStart.js';
import { buildPlayerDashboard } from '../services/playerDashboard.js';
import { buildSharedHealthProgress } from '../services/sharedHealthProgress.js';
import { findActiveMultiplayerGame, isPracticeGame } from '../services/activeGame.js';
import { leaveGame, startLobbyGame } from '../services/gameLifecycle.js';
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
import { createGame } from '../engine/setup.js';
import { CONTINENTS, CONTINENT_OF, NEIGHBORS } from '../engine/map.js';
import { currentPlayer } from '../engine/turnSession.js';
import type { GameConfig, GameState, HealthRuleGovernance } from '../engine/types.js';

const PLAYER_COLORS = ['#e05c4b', '#4b8fe0', '#3fae7a', '#c98a2b', '#8a63d2', '#d0518f'];
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
}


/** The active day + current actor for a game (hot-seat: actor = front of line). */
async function getActor(gameId: string): Promise<{ game: GameState; day: number; playerId: string | null }> {
  const game = await repo.loadGame(gameId);
  if (!game) throw new TurnError('no_game', 'Unknown game');
  const day = game.dayNumber;
  const session = await repo.loadSession(gameId, day);
  return { game, day, playerId: session ? currentPlayer(session) : null };
}

/** Serialize game state for the UI. `viewerId` marks which seat is "you". */
async function gameView(gameId: string, viewerId?: string) {
  let game = await repo.loadGame(gameId);
  if (!game) return null;
  const day0 = game.dayNumber;
  let session = await repo.loadSession(gameId, day0);
  const playerId = session ? currentPlayer(session) : null;

  // Starting the turn grants the current player their standard reinforcements.
  if (game.status === 'active' && playerId) await ensureTurnStarted(repo, gameId, day0, playerId);

  game = (await repo.loadGame(gameId))!;
  const colorOf = new Map(game.players.map((p, i) => [p.id, PLAYER_COLORS[i % PLAYER_COLORS.length]]));
  const turnState = playerId ? await repo.loadTurnState(gameId, game.dayNumber, playerId) : null;
  const members = await repo.listMembers(gameId);
  const seatOwner = new Map(members.map((m) => [m.playerId, m.userId]));
  const mySeats = viewerId ? members.filter((m) => m.userId === viewerId).map((m) => m.playerId) : [];
  const yourTurn = !!playerId && mySeats.includes(playerId);
  const dashboardPlayerId =
    game.status === 'active' ? (yourTurn ? playerId : mySeats[0] ?? null) : null;
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
  const scheduledPlayerWindowMinutes =
    game.status === 'setup' && !practice
      ? Math.floor((24 * 60) / game.players.length)
      : game.config.perPlayerWindowMinutes;
  const activeMultiplayerGameId = viewerId
    ? await findActiveMultiplayerGame(repo, viewerId)
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
    turnOrder: game.turnOrder,
    currentPlayerId: playerId,
    mySeats,
    isCreator: mySeats.includes(game.players[0]!.id),
    yourTurn,
    dashboard,
    phase: turnState?.phase ?? 'reinforce',
    startBonus: turnState?.startBonus ?? 0,
    startContinents: turnState?.startContinents ?? [],
    windowExpiresAt: session?.windowExpiresAt ?? null,
    perPlayerWindowMinutes: scheduledPlayerWindowMinutes,
    schedule: {
      timezone: game.config.timezone,
      dailyStartMinuteOfDay: game.config.windowStartMinuteOfDay,
      playerWindowMinutes: scheduledPlayerWindowMinutes,
      healthCutoffAt: session?.windowExpiresAt ?? null,
      missedTurnPolicy: 'auto_resolve',
    },
    claimedPlayerCount: members.length,
    players: game.players.map((p) => ({
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
    territories: game.territories.map((t) => ({
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
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(express.json());

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

// All browser mutations for one game run in order. Combined with the revision
// check, this makes double-clicks and stale tabs deterministic on a single app
// instance instead of allowing two old actions to race through together.
const mutationTails = new Map<string, Promise<void>>();

async function mutateGame<T>(
  req: express.Request,
  gameId: string,
  action: () => Promise<T>,
  requireRevision = true,
): Promise<T> {
  const previous = mutationTails.get(gameId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  mutationTails.set(gameId, tail);
  await previous;
  try {
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
  } finally {
    release();
    if (mutationTails.get(gameId) === tail) mutationTails.delete(gameId);
  }
}

const asyncH =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) => {
    fn(req, res).catch((err) => {
      if (err instanceof TurnError) {
        const code =
          err.code === 'unauthorized'
            ? 401
            : err.code === 'auth_rate_limited'
              ? 429
            : err.code === 'not_your_turn' || err.code === 'stale_game'
              ? 409
              : 400;
        res.status(code).json({ error: err.code, message: err.message });
      } else {
        console.error(err);
        res.status(500).json({ error: 'internal', message: String((err as Error)?.message ?? err) });
      }
    });
  };

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

/**
 * Create a game. The creator claims seat p1; with `practice: true` they claim
 * every seat (hot-seat play). Others join via /join with the returned game id.
 */
app.post(
  '/api/games',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const count = Math.min(Math.max(Number(req.body?.players ?? 2), 2), 6);
    const practice = Boolean(req.body?.practice);
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
    await repo.saveGame(game);

    if (practice) await claimAllSeats(repo, id, players.map((p) => p.id), user.id);
    else await claimSeat(repo, id, 'p1', user.id);

    if (practice) {
      await openDailySession(repo, id, 0);
      await scheduler.armNextWindow(id, 0);
    }
    res.json(await gameView(id, user.id));
  }),
);

app.post(
  '/api/games/:id/start',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const id = req.params.id as string;
    await mutateGame(req, id, async () => {
      await startLobbyGame(repo, id, user.id);
      await openDailySession(repo, id, 0);
      await scheduler.armNextWindow(id, 0);
    });
    res.json({ game: await gameView(id, user.id) });
  }),
);

app.post(
  '/api/games/:id/leave',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const id = req.params.id as string;
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
    await loadActiveGameForResponse();

    async function loadActiveGameForResponse() {
      res.json({
        ok: true,
        activeMultiplayerGameId: await findActiveMultiplayerGame(repo, user.id),
        game: await gameView(id, user.id),
      });
    }
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
    await mutateGame(req, id, async () => {
      try {
        await proposeHealthRules(repo, id, creatorSeat, req.body as HealthRulesInput);
      } catch (error) {
        throw new TurnError('bad_health_rules', (error as Error).message);
      }
    });
    res.json({ game: await gameView(id, user.id) });
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
    await mutateGame(req, id, async () => {
      for (const playerId of mySeats) {
        const latest = await repo.loadGame(id);
        if (latest?.pendingHealthRuleProposal?.status !== 'pending') break;
        await voteOnHealthRules(repo, id, playerId, Boolean(req.body?.approve));
      }
    });
    res.json({ game: await gameView(id, user.id) });
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
      await repo.saveGame({
        ...latest,
        players: latest.players.map((player) =>
          player.id === seat ? { ...player, name: user.username } : player,
        ),
      });
    }, false);
    res.json({ seat, game: await gameView(gameId, user.id) });
  }),
);

app.get(
  '/api/games/:id',
  asyncH(async (req, res) => {
    const view = await gameView((req.params.id as string), currentUser(req)?.id);
    if (!view) return res.status(404).json({ error: 'no_game' });
    res.json(view);
  }),
);

app.post(
  '/api/games/:id/reinforce',
  asyncH(async (req, res) => {
    const id = req.params.id as string;
    const out = await mutateGame(req, id, async () => {
      const { day, playerId } = await actingSeat(req, id);
      return api.placeReinforcements(id, day, playerId, req.body.placements ?? []);
    });
    res.json({ ...out, game: await gameView(id, currentUser(req)?.id) });
  }),
);

app.post(
  '/api/games/:id/cards/trade',
  asyncH(async (req, res) => {
    const id = req.params.id as string;
    const out = await mutateGame(req, id, async () => {
      const { day, playerId } = await actingSeat(req, id);
      return api.tradeCards(id, day, playerId);
    });
    res.json({ ...out, game: await gameView(id, currentUser(req)?.id) });
  }),
);

app.post(
  '/api/games/:id/attack',
  asyncH(async (req, res) => {
    const id = req.params.id as string;
    const result = await mutateGame(req, id, async () => {
      const { day, playerId } = await actingSeat(req, id);
      return api.attack(id, day, playerId, req.body);
    });
    res.json({ result, game: await gameView(id, currentUser(req)?.id) });
  }),
);

app.post(
  '/api/games/:id/fortify',
  asyncH(async (req, res) => {
    const id = req.params.id as string;
    await mutateGame(req, id, async () => {
      const { day, playerId } = await actingSeat(req, id);
      await api.fortify(id, day, playerId, req.body);
    });
    res.json({ game: await gameView(id, currentUser(req)?.id) });
  }),
);

app.post(
  '/api/games/:id/end',
  asyncH(async (req, res) => {
    const id = req.params.id as string;
    const out = await mutateGame(req, id, async () => {
      const { day, playerId } = await actingSeat(req, id);
      return api.endTurn(id, day, playerId);
    });
    res.json({ ...out, game: await gameView(id, currentUser(req)?.id) });
  }),
);

/** Log exercise for your own seat, banking troops (§3). */
app.post(
  '/api/games/:id/exercise',
  asyncH(async (req, res) => {
    const id = req.params.id as string;
    const out = await mutateGame(req, id, async () => {
      const { day, playerId } = await actingSeat(req, id);
      return logExercise(repo, id, day, playerId, {
        exerciseKey: String(req.body.exerciseKey),
        units: Number(req.body.units),
      });
    });
    res.json({ ...out, game: await gameView(id, currentUser(req)?.id) });
  }),
);

/** Dev: auto-resolve the current player's turn. Restricted to game members. */
app.post(
  '/api/games/:id/expire',
  asyncH(async (req, res) => {
    const user = requireUser(req);
    const id = req.params.id as string;
    if (!(await seatFor(repo, id, user.id))) throw new TurnError('no_seat', 'Not a member of this game');
    await mutateGame(req, id, async () => {
      const { day, playerId } = await getActor(id);
      if (!playerId) throw new TurnError('no_turn', 'No active turn');
      await handleWindowExpiry(repo, throwingPlanner, id, day);
      await scheduler.armNextWindow(id, day);
    });
    res.json({ game: await gameView(id, user.id) });
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
app.use(express.static(path.join(here, '../../public')));

async function main() {
  if (process.env.EXRISK_MEMORY) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('EXRISK_MEMORY cannot be used when NODE_ENV=production');
    }
    repo = new InMemoryGameRepository();
    console.log('Store: in-memory (ephemeral)');
  } else {
    database = await createDb();
    repo = new DrizzleGameRepository(database.db);
    console.log(
      `Store: ${database.kind} @ ${database.location} (schema v${database.migrationVersion}, ${database.persistent ? 'persistent' : 'ephemeral'})`,
    );
  }
  api = new TurnApi({ repo, onPlayerCompleted });

  // Hosted Postgres uses pg-boss so daily deadlines survive restarts. Local
  // PGlite keeps zero-setup setTimeout timers, then reconstructs them from the
  // persisted session deadline whenever the app starts again.
  const queue =
    database?.kind === 'postgres' && process.env.DATABASE_URL
      ? (durableSchedulerQueue = new PgBossJobQueue(process.env.DATABASE_URL))
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
  } else {
    console.log('Turn scheduler: in-process (startup recovery enabled)');
  }
  const recoveredGames = await scheduler.recoverActiveGames();
  if (recoveredGames) console.log(`Turn scheduler: restored ${recoveredGames} active game(s)`);

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

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
