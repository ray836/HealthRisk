/**
 * Interactive turn API (§4) — the surface a *present* player drives during their
 * 20-minute window: place reinforcements, attack, fortify, end turn.
 *
 * Every action is validated through the engine primitives (so it can never
 * produce an illegal board), guarded by "is it actually your turn" (you must be
 * at the front of the current day's line), and ordered by phase:
 *
 *   reinforce* -> attack* -> fortify? -> end
 *
 * Once you attack you can no longer reinforce; once you fortify you can no longer
 * attack or fortify again. `maxAttacksPerTurn` is enforced here just as it is on
 * the auto-resolution path. Ending the turn delegates to the scheduler hook
 * (`onPlayerCompleted`), which advances the line and schedules the next window.
 *
 * "Your window expired" needs no timer check here: when the window elapses the
 * scheduler auto-resolves the turn and advances the line, so you're no longer at
 * the front and the turn guard rejects further actions.
 */

import {
  validateAttack,
  resolveAttack,
  applyAttackResult,
  type AttackDeclaration,
  type AttackResult,
  type ValidationError,
} from '../engine/combat.js';
import {
  validateReinforcement,
  applyReinforcement,
  type ReinforcePlacement,
} from '../engine/reinforce.js';
import { validateFortify, applyFortify, type FortifyMove } from '../engine/fortify.js';
import { applyEliminations, checkWin } from '../engine/game.js';
import {
  recordAttackEvent,
  recordCardsTradedEvent,
  recordFortifiedEvent,
} from '../engine/gameEvents.js';
import {
  applyCardTrade,
  awardConquestCard,
  CARD_TRADE_REINFORCEMENTS,
  validateCardTrade,
} from '../engine/cards.js';
import { buildPlannerContext, type PlannerContext } from '../engine/planner.js';
import { currentPlayer, pruneIneligiblePlayers } from '../engine/turnSession.js';
import type { GameState, TerritoryCard } from '../engine/types.js';
import type { GameRepository, TurnPhase, TurnState } from './repository.js';
import { ensureTurnStarted } from './turnStart.js';

/** Thrown for any rejected action; `code` is stable for an HTTP layer to map. */
export class TurnError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TurnError';
  }
}

function fromValidation(err: ValidationError): TurnError {
  return new TurnError(err.code, err.message);
}

/** Called when a player finishes in time — in production, scheduler.onPlayerCompleted. */
export type CompleteHook = (gameId: string, dayNumber: number, playerId: string) => Promise<void>;

export interface TurnApiDeps {
  repo: GameRepository;
  onPlayerCompleted: CompleteHook;
}

export interface TurnView {
  playerId: string;
  phase: TurnPhase;
  attacksMade: number;
  /** Start-of-turn standard reinforcements granted (territory + continent). */
  startBonus: number;
  startContinents: string[];
  /** Board/holdings/legal-attack context for the current player (UI-ready). */
  context: PlannerContext;
}

export interface CardTradeResult {
  remainingBank: number;
  remainingCards: number;
  troopsAwarded: number;
}

export interface EndTurnResult {
  cardAwarded: TerritoryCard | null;
}

export class TurnApi {
  private repo: GameRepository;
  private onPlayerCompleted: CompleteHook;

  constructor(deps: TurnApiDeps) {
    this.repo = deps.repo;
    this.onPlayerCompleted = deps.onPlayerCompleted;
  }

  /** Whose turn it is, their phase, and the board context — null if no one is up. */
  async turnView(gameId: string, dayNumber: number): Promise<TurnView | null> {
    const session0 = await this.repo.loadSession(gameId, dayNumber);
    if (!session0) return null;
    const playerId = currentPlayer(session0);
    if (playerId === null) return null;
    // Start the turn if it hasn't been (grants standard reinforcements).
    await ensureTurnStarted(this.repo, gameId, dayNumber, playerId);
    const game = await this.repo.loadGame(gameId);
    if (!game) return null;
    const ts = await this.repo.loadTurnState(gameId, dayNumber, playerId);
    const bank = game.players.find((p) => p.id === playerId)?.pendingReinforcements ?? 0;
    const phase = ts?.phase ?? (bank > 0 ? 'reinforce' : 'attack');
    return {
      playerId,
      phase,
      attacksMade: ts?.attacksMade ?? 0,
      startBonus: ts?.startBonus ?? 0,
      startContinents: ts?.startContinents ?? [],
      context: buildPlannerContext(game, playerId),
    };
  }

  async placeReinforcements(
    gameId: string,
    dayNumber: number,
    playerId: string,
    placements: ReinforcePlacement[],
  ): Promise<{ remainingBank: number }> {
    const { game, turnState } = await this.begin(gameId, dayNumber, playerId);
    if (turnState.phase !== 'reinforce') {
      throw new TurnError('reinforce_phase_over', 'Reinforcement phase is over for this turn');
    }
    const err = validateReinforcement(game, playerId, placements);
    if (err) throw fromValidation(err);
    const next = applyReinforcement(game, playerId, placements);
    await this.repo.saveGame(next);
    turnState.reinforcementTroopsPlaced =
      (turnState.reinforcementTroopsPlaced ?? 0) +
      placements.reduce((total, placement) => total + placement.count, 0);
    turnState.reinforcementPlacementsMade =
      (turnState.reinforcementPlacementsMade ?? 0) + placements.length;
    const bank = next.players.find((p) => p.id === playerId)!.pendingReinforcements;
    // Reinforcements are mandatory and placed in full — once the bank is empty
    // the reinforce phase is over and the turn advances to attack automatically.
    if (bank === 0) turnState.phase = 'attack';
    await this.repo.saveTurnState(turnState);
    return { remainingBank: bank };
  }

  async attack(
    gameId: string,
    dayNumber: number,
    playerId: string,
    decl: AttackDeclaration,
  ): Promise<AttackResult> {
    const { game, turnState } = await this.begin(gameId, dayNumber, playerId);
    if (turnState.phase === 'reinforce') {
      throw new TurnError('place_reinforcements_first', 'Place all your reinforcements before attacking');
    }
    if (turnState.phase !== 'attack') {
      throw new TurnError('attack_phase_over', 'You can no longer attack this turn');
    }
    const cap = game.config.maxAttacksPerTurn;
    if (cap !== null && turnState.attacksMade >= cap) {
      throw new TurnError('max_attacks_reached', `Attack limit (${cap}) reached this turn`);
    }
    const err = validateAttack(game, playerId, decl);
    if (err) throw fromValidation(err);

    const defenderArmies = game.territories.find((t) => t.id === decl.toId)!.armies;
    const combatId = `${gameId}:${dayNumber}:${playerId}:atk:${turnState.attacksMade}`;
    const result = resolveAttack(
      decl.committedTroops,
      defenderArmies,
      decl.stopLoss,
      combatId,
      decl.fromId,
      decl.toId,
    );

    let next = applyAttackResult(game, playerId, decl, result);
    next = recordAttackEvent(game, next, playerId, decl, result, `${combatId}:event`);
    next = applyEliminations(next, playerId);
    next = checkWin(next);
    await this.repo.saveGame(next);
    const session = await this.repo.loadSession(gameId, dayNumber);
    if (session) await this.repo.saveSession(pruneIneligiblePlayers(session, next));

    turnState.phase = 'attack';
    turnState.attacksMade += 1;
    turnState.attackerLosses = (turnState.attackerLosses ?? 0) + result.totalAttackerLosses;
    turnState.defenderLosses = (turnState.defenderLosses ?? 0) + result.totalDefenderLosses;
    if (result.captured && !turnState.capturedTerritoryId) {
      turnState.capturedTerritoryId = decl.toId;
    }
    if (result.captured) {
      turnState.territoriesCaptured = [
        ...(turnState.territoriesCaptured ?? []),
        decl.toId,
      ];
    }
    await this.repo.saveTurnState(turnState);
    return result;
  }

  /** Trade any three conquest cards for a fixed three troops during reinforce. */
  async tradeCards(gameId: string, dayNumber: number, playerId: string): Promise<CardTradeResult> {
    const { game, turnState } = await this.begin(gameId, dayNumber, playerId);
    if (turnState.phase !== 'reinforce') {
      throw new TurnError('card_trade_phase_over', 'Cards can only be traded during reinforcement');
    }
    const error = validateCardTrade(game, playerId);
    if (error) throw new TurnError(error.code, error.message);

    const tradedCardIds = (game.players.find((player) => player.id === playerId)?.cards ?? [])
      .slice(0, 3)
      .map((card) => card.id)
      .join(':');
    let next = applyCardTrade(game, playerId);
    next = recordCardsTradedEvent(
      next,
      playerId,
      CARD_TRADE_REINFORCEMENTS,
      `${gameId}:${dayNumber}:${playerId}:trade:${tradedCardIds}`,
    );
    await this.repo.saveGame(next);
    turnState.cardsTraded = (turnState.cardsTraded ?? 0) + 1;
    await this.repo.saveTurnState(turnState);
    const player = next.players.find((candidate) => candidate.id === playerId)!;
    return {
      remainingBank: player.pendingReinforcements,
      remainingCards: player.cards?.length ?? 0,
      troopsAwarded: CARD_TRADE_REINFORCEMENTS,
    };
  }

  async fortify(gameId: string, dayNumber: number, playerId: string, move: FortifyMove): Promise<void> {
    const { game, turnState } = await this.begin(gameId, dayNumber, playerId);
    if (turnState.phase === 'reinforce') {
      throw new TurnError('place_reinforcements_first', 'Place all your reinforcements first');
    }
    if (turnState.phase === 'fortify') {
      throw new TurnError('fortify_already_done', 'You have already made your fortify move');
    }
    const err = validateFortify(game, playerId, move);
    if (err) throw fromValidation(err);
    let next = applyFortify(game, move);
    next = recordFortifiedEvent(
      next,
      playerId,
      move,
      `${gameId}:${dayNumber}:${playerId}:fortify`,
    );
    await this.repo.saveGame(next);
    turnState.phase = 'fortify';
    turnState.fortifiedTroops = move.count;
    turnState.fortifiedFromId = move.fromId;
    turnState.fortifiedToId = move.toId;
    await this.repo.saveTurnState(turnState);
  }

  /** End the turn (any phase). Advances the line via the scheduler hook. */
  async endTurn(gameId: string, dayNumber: number, playerId: string): Promise<EndTurnResult> {
    const { game } = await this.guard(gameId, dayNumber, playerId);
    const startingTurnState = await this.repo.loadTurnState(gameId, dayNumber, playerId);
    let cardAwarded: TerritoryCard | null = null;
    if (startingTurnState?.capturedTerritoryId && !startingTurnState.conquestCardAwarded) {
      const award = awardConquestCard(
        game,
        playerId,
        dayNumber,
        startingTurnState.capturedTerritoryId,
      );
      if (award.awarded) await this.repo.saveGame(award.state);
      cardAwarded = award.card;
      startingTurnState.conquestCardAwarded = true;
      await this.repo.saveTurnState(startingTurnState);
    }

    await this.onPlayerCompleted(gameId, dayNumber, playerId);
    const ts = await this.repo.loadTurnState(gameId, dayNumber, playerId);
    if (ts) {
      ts.phase = 'done';
      await this.repo.saveTurnState(ts);
    }
    return { cardAwarded };
  }

  /** Assert it's this player's turn on an active game/session. */
  private async guard(
    gameId: string,
    dayNumber: number,
    playerId: string,
  ): Promise<{ game: GameState }> {
    const game = await this.repo.loadGame(gameId);
    if (!game) throw new TurnError('no_game', 'Unknown game');
    if (game.status !== 'active') throw new TurnError('game_not_active', 'Game is not active');
    const session = await this.repo.loadSession(gameId, dayNumber);
    if (!session) throw new TurnError('no_session', 'No open session for this day');
    if (currentPlayer(session) !== playerId) throw new TurnError('not_your_turn', 'It is not your turn');
    const player = game.players.find((p) => p.id === playerId);
    if (!player) throw new TurnError('no_player', 'Unknown player');
    if (player.status === 'eliminated' || player.status === 'forfeited') {
      throw new TurnError('not_active_player', 'You cannot take actions');
    }
    return { game };
  }

  /**
   * Guard + ensure a TurnState exists. A turn starts in the reinforce phase only
   * if the player has troops to place; with an empty bank it starts in attack
   * (nothing to reinforce).
   */
  private async begin(
    gameId: string,
    dayNumber: number,
    playerId: string,
  ): Promise<{ game: GameState; turnState: TurnState }> {
    await this.guard(gameId, dayNumber, playerId);
    // Grants standard reinforcements + creates the TurnState the first time.
    await ensureTurnStarted(this.repo, gameId, dayNumber, playerId);
    const game = (await this.repo.loadGame(gameId))!; // reload: bank now includes the bonus
    const turnState = (await this.repo.loadTurnState(gameId, dayNumber, playerId))!;
    if (turnState.phase === 'done') throw new TurnError('turn_already_ended', 'Turn already ended');
    return { game, turnState };
  }
}
