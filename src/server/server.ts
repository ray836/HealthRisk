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
import { createDb } from '../../db/client.js';
import { TurnApi, TurnError } from '../services/turnApi.js';
import { openDailySession, handleWindowExpiry, systemClock } from '../services/orchestrator.js';
import { GameScheduler } from '../services/scheduling/gameScheduler.js';
import { InProcessJobQueue } from '../services/scheduling/jobQueue.js';
import { logExercise } from '../services/exerciseApi.js';
import { ensureTurnStarted } from '../services/turnStart.js';
import { buildPlayerDashboard } from '../services/playerDashboard.js';
import {
  proposeHealthRules,
  voteOnHealthRules,
  withHealthRules,
  type HealthRulesInput,
} from '../services/healthRules.js';
import { signup, login, logout, resolveToken, type PublicUser } from '../services/authApi.js';
import { claimSeat, claimAllSeats, claimOpenSeat, seatFor } from '../services/membership.js';
import { createGame } from '../engine/setup.js';
import { CONTINENTS, CONTINENT_OF, NEIGHBORS } from '../engine/map.js';
import { currentPlayer } from '../engine/turnSession.js';
import type { GameConfig, GameState, HealthRuleGovernance } from '../engine/types.js';

const PLAYER_COLORS = ['#e05c4b', '#4b8fe0', '#3fae7a', '#c98a2b', '#8a63d2', '#d0518f'];
const MIN_PLAYER_WINDOW_MINUTES = 20;

// Assigned in main() before the server accepts requests.
let repo: GameRepository;
let api: TurnApi;
let scheduler: GameScheduler;

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

  // Migrate games created with the old three-minute demo setting. Re-arming
  // also gives the current player a fresh full window instead of retaining the
  // shorter persisted deadline.
  if (game.config.perPlayerWindowMinutes < MIN_PLAYER_WINDOW_MINUTES) {
    game = {
      ...game,
      config: { ...game.config, perPlayerWindowMinutes: MIN_PLAYER_WINDOW_MINUTES },
    };
    await repo.saveGame(game);
    if (playerId) {
      await scheduler.armNextWindow(gameId, day0);
      session = await repo.loadSession(gameId, day0);
    }
  }

  // Starting the turn grants the current player their standard reinforcements.
  if (playerId) await ensureTurnStarted(repo, gameId, day0, playerId);

  game = (await repo.loadGame(gameId))!;
  const colorOf = new Map(game.players.map((p, i) => [p.id, PLAYER_COLORS[i % PLAYER_COLORS.length]]));
  const turnState = playerId ? await repo.loadTurnState(gameId, game.dayNumber, playerId) : null;
  const members = await repo.listMembers(gameId);
  const seatOwner = new Map(members.map((m) => [m.playerId, m.userId]));
  const mySeats = viewerId ? members.filter((m) => m.userId === viewerId).map((m) => m.playerId) : [];
  const yourTurn = !!playerId && mySeats.includes(playerId);
  const dashboardPlayerId = yourTurn ? playerId : mySeats[0] ?? null;
  const dashboardTurnState = dashboardPlayerId
    ? await repo.loadTurnState(gameId, game.dayNumber, dashboardPlayerId)
    : null;
  const dashboard = dashboardPlayerId
    ? await buildPlayerDashboard(repo, gameId, game.dayNumber, dashboardPlayerId, dashboardTurnState)
    : null;

  return {
    id: game.id,
    status: game.status,
    winnerId: game.winnerId ?? null,
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
    perPlayerWindowMinutes: game.config.perPlayerWindowMinutes,
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      color: colorOf.get(p.id),
      pendingReinforcements: p.pendingReinforcements,
      note: p.standingOrdersNote,
      claimed: seatOwner.has(p.id),
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
app.use(express.json());

function bearer(req: express.Request): string | undefined {
  const h = req.header('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

// Resolve the bearer token to a user (best-effort) on every request.
app.use((req, _res, next) => {
  resolveToken(repo, bearer(req))
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

const asyncH =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) => {
    fn(req, res).catch((err) => {
      if (err instanceof TurnError) {
        const code = err.code === 'unauthorized' ? 401 : err.code === 'not_your_turn' ? 409 : 400;
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
    res.json(await signup(repo, String(req.body?.username ?? ''), String(req.body?.password ?? '')));
  }),
);
app.post(
  '/api/auth/login',
  asyncH(async (req, res) => {
    res.json(await login(repo, String(req.body?.username ?? ''), String(req.body?.password ?? '')));
  }),
);
app.post(
  '/api/auth/logout',
  asyncH(async (req, res) => {
    await logout(repo, bearer(req));
    res.json({ ok: true });
  }),
);
app.get(
  '/api/auth/me',
  asyncH(async (req, res) => {
    res.json({ user: currentUser(req) });
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
    const players = Array.from({ length: count }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}` }));
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
    config = { ...config, healthRuleGovernance: governance };
    const game = createGame({ id, config, players, seed: (Math.random() * 2 ** 31) | 0 });
    game.healthRulesVersion = 1;
    await repo.saveGame(game);

    if (practice) await claimAllSeats(repo, id, players.map((p) => p.id), user.id);
    else await claimSeat(repo, id, 'p1', user.id);

    await openDailySession(repo, id, 0);
    await scheduler.armNextWindow(id, 0);
    res.json(await gameView(id, user.id));
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
    try {
      await proposeHealthRules(repo, id, creatorSeat, req.body as HealthRulesInput);
    } catch (error) {
      throw new TurnError('bad_health_rules', (error as Error).message);
    }
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
    for (const playerId of mySeats) {
      const latest = await repo.loadGame(id);
      if (latest?.pendingHealthRuleProposal?.status !== 'pending') break;
      await voteOnHealthRules(repo, id, playerId, Boolean(req.body?.approve));
    }
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
    const seat = await claimOpenSeat(repo, gameId, game.players.map((p) => p.id), user.id);
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
    const { day, playerId } = await actingSeat(req, id);
    const out = await api.placeReinforcements(id, day, playerId, req.body.placements ?? []);
    res.json({ ...out, game: await gameView(id, currentUser(req)?.id) });
  }),
);

app.post(
  '/api/games/:id/cards/trade',
  asyncH(async (req, res) => {
    const id = req.params.id as string;
    const { day, playerId } = await actingSeat(req, id);
    const out = await api.tradeCards(id, day, playerId);
    res.json({ ...out, game: await gameView(id, currentUser(req)?.id) });
  }),
);

app.post(
  '/api/games/:id/attack',
  asyncH(async (req, res) => {
    const id = req.params.id as string;
    const { day, playerId } = await actingSeat(req, id);
    const result = await api.attack(id, day, playerId, req.body);
    res.json({ result, game: await gameView(id, currentUser(req)?.id) });
  }),
);

app.post(
  '/api/games/:id/fortify',
  asyncH(async (req, res) => {
    const id = req.params.id as string;
    const { day, playerId } = await actingSeat(req, id);
    await api.fortify(id, day, playerId, req.body);
    res.json({ game: await gameView(id, currentUser(req)?.id) });
  }),
);

app.post(
  '/api/games/:id/end',
  asyncH(async (req, res) => {
    const id = req.params.id as string;
    const { day, playerId } = await actingSeat(req, id);
    const out = await api.endTurn(id, day, playerId);
    res.json({ ...out, game: await gameView(id, currentUser(req)?.id) });
  }),
);

/** Log exercise for your own seat, banking troops (§3). */
app.post(
  '/api/games/:id/exercise',
  asyncH(async (req, res) => {
    const id = req.params.id as string;
    const { day, playerId } = await actingSeat(req, id);
    const out = await logExercise(repo, id, day, playerId, {
      exerciseKey: String(req.body.exerciseKey),
      units: Number(req.body.units),
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
    const { day, playerId } = await getActor(id);
    if (!playerId) throw new TurnError('no_turn', 'No active turn');
    await handleWindowExpiry(repo, throwingPlanner, id, day);
    await scheduler.armNextWindow(id, day);
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
    // Never shorter than twenty minutes. EXRISK_WINDOW_MIN may make the
    // window longer; players can always end their turn early.
    perPlayerWindowMinutes: Math.max(
      MIN_PLAYER_WINDOW_MINUTES,
      Number(process.env.EXRISK_WINDOW_MIN ?? MIN_PLAYER_WINDOW_MINUTES) || MIN_PLAYER_WINDOW_MINUTES,
    ),
    autoForfeitAfterDays: null,
    autoAttackStopLoss: 3,
    maxAttacksPerTurn: null,
    timezone: 'America/New_York',
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(here, '../../public')));

async function main() {
  if (process.env.EXRISK_MEMORY) {
    repo = new InMemoryGameRepository();
    console.log('Store: in-memory (ephemeral)');
  } else {
    const handle = await createDb();
    repo = new DrizzleGameRepository(handle.db);
    console.log(`Store: ${handle.kind} @ ${handle.location} (persistent)`);
  }
  api = new TurnApi({ repo, onPlayerCompleted });

  // Real turn-window timers. In-process setTimeout queue (fits the embedded
  // PGlite store, which has no Postgres server for pg-boss). Demo opens the next
  // day immediately for continuous play; the real cadence uses next-7pm.
  scheduler = new GameScheduler({
    repo,
    planner: throwingPlanner,
    queue: new InProcessJobQueue(),
    clock: systemClock,
    nextDayOpenAt: (_config, now) => now,
  });
  scheduler.register();

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`Exercise Risk demo running at http://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
