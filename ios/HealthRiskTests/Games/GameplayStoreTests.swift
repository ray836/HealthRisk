import XCTest
@testable import HealthRisk

@MainActor
final class GameplayStoreTests: XCTestCase {
    func testLoadsAuthoritativeGameplayView() async {
        let game = gameplayGame(revision: 4, phase: .reinforce, reinforcements: 5)
        let api = MockHealthRiskAPI(gameplayGameResult: .success(game))
        let store = GameplayStore(gameId: game.id, api: api)

        await store.load()

        XCTAssertEqual(store.game, game)
        XCTAssertNil(store.error)
        XCTAssertFalse(store.isLoading)
    }

    func testAutomaticSynchronizationAppliesNewServerRevision() async {
        let initial = gameplayGame(revision: 4, phase: .attack, reinforcements: 0)
        let updated = gameplayGame(
            revision: 5,
            phase: .attack,
            reinforcements: 0,
            currentPlayerId: "p2",
            yourTurn: false
        )
        let api = MockHealthRiskAPI(
            gameplayGameResults: [.success(initial), .success(updated)]
        )
        let store = GameplayStore(
            gameId: initial.id,
            api: api,
            syncSleeper: OneRefreshGameplaySyncSleeper()
        )

        await store.synchronize()

        let callCount = await api.recordedGameplayGameCallCount()
        XCTAssertEqual(store.game, updated)
        XCTAssertEqual(callCount, 2)
        XCTAssertFalse(store.isRefreshing)
    }

    func testAutomaticSynchronizationDoesNotReplaceNewerGameWithOlderResponse() async {
        let newest = gameplayGame(revision: 8, phase: .attack, reinforcements: 0)
        let stale = gameplayGame(revision: 7, phase: .reinforce, reinforcements: 4)
        let api = MockHealthRiskAPI(
            gameplayGameResults: [.success(newest), .success(stale)]
        )
        let store = GameplayStore(
            gameId: newest.id,
            api: api,
            syncSleeper: OneRefreshGameplaySyncSleeper()
        )

        await store.synchronize()

        XCTAssertEqual(store.game, newest)
    }

    func testReinforcementUsesLatestRevisionAndAppliesServerResponse() async {
        let initial = gameplayGame(revision: 4, phase: .reinforce, reinforcements: 5)
        let updated = gameplayGame(revision: 5, phase: .reinforce, reinforcements: 3)
        let api = MockHealthRiskAPI(
            gameplayGameResult: .success(initial),
            reinforceResult: .success(GameplayMutationResponse(game: updated))
        )
        let store = GameplayStore(gameId: initial.id, api: api)
        await store.load()

        let succeeded = await store.reinforce(territoryId: "alaska", count: 2)

        XCTAssertTrue(succeeded)
        XCTAssertEqual(store.game, updated)
        XCTAssertNil(store.actionError)
        XCTAssertFalse(store.isPerformingAction)
        let requests = await api.recordedReinforcements()
        XCTAssertEqual(
            requests,
            [
                MockHealthRiskAPI.RecordedReinforcement(
                    gameId: "game-play",
                    request: ReinforcementRequest(
                        revision: 4,
                        placements: [ReinforcementPlacement(territoryId: "alaska", count: 2)]
                    )
                ),
            ]
        )
    }

    func testCardTradeUsesCurrentRevisionAndAppliesServerResponse() async {
        let dashboard = gameplayDashboard(cardCount: 3, canTrade: true)
        let initial = gameplayGame(
            revision: 9,
            phase: .reinforce,
            reinforcements: 2,
            dashboard: dashboard
        )
        let updated = gameplayGame(
            revision: 10,
            phase: .reinforce,
            reinforcements: 5,
            dashboard: gameplayDashboard(cardCount: 0, canTrade: false)
        )
        let api = MockHealthRiskAPI(
            gameplayGameResult: .success(initial),
            cardTradeResult: .success(
                CardTradeMutationResponse(
                    remainingBank: 5,
                    remainingCards: 0,
                    troopsAwarded: 3,
                    game: updated
                )
            )
        )
        let store = GameplayStore(gameId: initial.id, api: api)
        await store.load()

        let succeeded = await store.tradeCards()
        let trades = await api.recordedCardTrades()

        XCTAssertTrue(succeeded)
        XCTAssertEqual(store.game, updated)
        XCTAssertEqual(
            trades,
            [
                MockHealthRiskAPI.RecordedCardTrade(
                    gameId: "game-play",
                    request: RevisionRequest(revision: 9)
                ),
            ]
        )
    }

    func testFinishedTurnPublishesAwardedCard() async {
        let summary = GameplayTurnSummary(
            reinforcementsPlaced: 5,
            placementsMade: 2,
            attacksMade: 4,
            attackerLosses: 3,
            defenderLosses: 7,
            territoriesCaptured: ["alaska"],
            cardsTraded: 0,
            cardPending: true,
            fortification: nil
        )
        let initial = gameplayGame(
            revision: 11,
            phase: .done,
            reinforcements: 0,
            dashboard: gameplayDashboard(turnSummary: summary)
        )
        let updated = gameplayGame(
            revision: 12,
            phase: .reinforce,
            reinforcements: 0,
            currentPlayerId: "p2",
            yourTurn: false
        )
        let awarded = TerritoryCard(id: "card-1", territoryId: "alaska", earnedDay: 0)
        let api = MockHealthRiskAPI(
            gameplayGameResult: .success(initial),
            endTurnResult: .success(
                GameplayMutationResponse(game: updated, cardAwarded: awarded)
            )
        )
        let store = GameplayStore(gameId: initial.id, api: api)
        await store.load()

        let succeeded = await store.endTurn()
        let endedTurns = await api.recordedEndedTurns()

        XCTAssertTrue(succeeded)
        XCTAssertEqual(store.lastAwardedCard, awarded)
        XCTAssertEqual(
            endedTurns,
            [
                MockHealthRiskAPI.RecordedEndTurn(
                    gameId: "game-play",
                    request: RevisionRequest(revision: 11)
                ),
            ]
        )
    }

    func testPracticeGameDeletionUsesCurrentRevisionAndClearsLoadedGame() async {
        let initial = gameplayGame(
            revision: 13,
            phase: .attack,
            reinforcements: 0,
            practice: true
        )
        let api = MockHealthRiskAPI(
            deletePracticeGameResult: .success(OkResponse(ok: true)),
            gameplayGameResult: .success(initial)
        )
        let store = GameplayStore(gameId: initial.id, api: api)
        await store.load()

        let succeeded = await store.deletePracticeGame()
        let deletions = await api.recordedPracticeDeletions()

        XCTAssertTrue(succeeded)
        XCTAssertNil(store.game)
        XCTAssertNil(store.actionError)
        XCTAssertEqual(
            deletions,
            [
                MockHealthRiskAPI.RecordedPracticeDeletion(
                    gameId: "game-play",
                    request: RevisionRequest(revision: 13)
                ),
            ]
        )
    }

    func testMultiplayerForfeitUsesCurrentRevisionAndClosesGameplay() async {
        let initial = gameplayGame(revision: 14, phase: .attack, reinforcements: 0)
        let forfeitedView = GameView(
            id: initial.id,
            revision: 15,
            status: .finished,
            practice: false,
            yourTurn: false,
            players: [],
            territories: [],
            chatMessages: [],
            schedule: nil
        )
        let api = MockHealthRiskAPI(
            leaveGameResult: .success(
                LeaveGameResponse(
                    ok: true,
                    activeMultiplayerGameId: nil,
                    game: forfeitedView
                )
            ),
            gameplayGameResult: .success(initial)
        )
        let store = GameplayStore(gameId: initial.id, api: api)
        await store.load()

        let succeeded = await store.forfeitGame()
        let exits = await api.recordedGameExits()

        XCTAssertTrue(succeeded)
        XCTAssertNil(store.game)
        XCTAssertNil(store.actionError)
        XCTAssertEqual(
            exits,
            [
                MockHealthRiskAPI.RecordedGameExit(
                    gameId: "game-play",
                    request: RevisionRequest(revision: 14)
                ),
            ]
        )
    }

    func testFinishedGamePresentationIdentifiesWinnerAndStandings() throws {
        let game = gameplayGame(
            revision: 20,
            phase: .done,
            reinforcements: 0,
            status: .finished,
            winnerId: "p1",
            currentPlayerId: nil,
            yourTurn: false
        )

        let presentation = try XCTUnwrap(GameCompletionPresentation(game: game))

        XCTAssertTrue(presentation.didWin)
        XCTAssertEqual(presentation.winnerName, "Ray")
        XCTAssertEqual(presentation.standings.first?.id, "p1")
        XCTAssertEqual(presentation.standings.first?.territories, 2)
    }

    func testRejectedAttackKeepsBoardAndPublishesServerError() async {
        let initial = gameplayGame(revision: 6, phase: .attack, reinforcements: 0)
        let serverError = APIError(
            statusCode: 400,
            code: "not_adjacent",
            message: "Territories are not adjacent",
            requestId: "request-attack",
            retryable: false
        )
        let api = MockHealthRiskAPI(
            gameplayGameResult: .success(initial),
            attackResult: .failure(serverError)
        )
        let store = GameplayStore(gameId: initial.id, api: api)
        await store.load()

        let succeeded = await store.attack(
            fromId: "alaska",
            toId: "brazil",
            committedTroops: 2,
            stopLoss: 1
        )

        XCTAssertFalse(succeeded)
        XCTAssertEqual(store.game, initial)
        XCTAssertEqual(store.actionError, serverError)
        XCTAssertFalse(store.isPerformingAction)
    }

    func testAllInAttackUsesOneMutationAndPublishesAuthoritativeBattleResult() async {
        let initial = gameplayGame(revision: 6, phase: .attack, reinforcements: 0)
        let updated = gameplayGame(revision: 7, phase: .attack, reinforcements: 0)
        let result = AttackResult(
            fromId: "alaska",
            toId: "northwest_territory",
            endReason: .capture,
            captured: true,
            rounds: [
                CombatRound(
                    attackerDice: [6, 5, 3],
                    defenderDice: [4, 2],
                    attackerLosses: 0,
                    defenderLosses: 2,
                    attackerForceAfter: 3,
                    defenderForceAfter: 0
                ),
            ],
            totalAttackerLosses: 0,
            totalDefenderLosses: 2,
            survivingAttackers: 3,
            remainingDefenders: 0,
            seed: 42
        )
        let api = MockHealthRiskAPI(
            gameplayGameResult: .success(initial),
            attackResult: .success(AttackMutationResponse(result: result, game: updated))
        )
        let store = GameplayStore(gameId: initial.id, api: api)
        await store.load()

        let succeeded = await store.attack(
            fromId: "alaska",
            toId: "northwest_territory",
            committedTroops: 3,
            stopLoss: 3
        )

        XCTAssertTrue(succeeded)
        XCTAssertEqual(store.game, updated)
        XCTAssertEqual(store.lastAttackResult, result)
        let attacks = await api.recordedAttacks()
        XCTAssertEqual(
            attacks,
            [
                MockHealthRiskAPI.RecordedAttack(
                    gameId: "game-play",
                    request: AttackRequest(
                        revision: 6,
                        fromId: "alaska",
                        toId: "northwest_territory",
                        committedTroops: 3,
                        stopLoss: 3
                    )
                ),
            ]
        )
    }

    func testAttackRiskPolicyDefaultsToAllAvailableTroopsAndHonorsLowerLossLimit() {
        let committedTroops = AttackRiskPolicy.committedTroops(sourceArmies: 6)

        XCTAssertEqual(committedTroops, 5)
        XCTAssertEqual(
            AttackRiskPolicy.stopLoss(
                committedTroops: committedTroops,
                limitsLosses: false,
                selectedLimit: 1
            ),
            5
        )
        XCTAssertEqual(
            AttackRiskPolicy.stopLoss(
                committedTroops: committedTroops,
                limitsLosses: true,
                selectedLimit: 2
            ),
            2
        )
    }

    func testActionModeFollowsTurnSequenceWithoutOverridingMidAttackChoice() {
        XCTAssertEqual(
            GameplayActionMode.synchronized(
                current: .fortify,
                previousPhase: .reinforce,
                phase: .attack,
                playerChanged: false
            ),
            .attack
        )
        XCTAssertEqual(
            GameplayActionMode.synchronized(
                current: .fortify,
                previousPhase: .attack,
                phase: .attack,
                playerChanged: false
            ),
            .fortify
        )
        XCTAssertEqual(
            GameplayActionMode.synchronized(
                current: .fortify,
                previousPhase: .attack,
                phase: .attack,
                playerChanged: true
            ),
            .attack
        )
    }

    func testSelectionGuideHighlightsOnlyOwnedReinforcementTargets() {
        let game = gameplayGame(revision: 1, phase: .reinforce, reinforcements: 5)

        let guide = GameplaySelectionGuide.make(
            game: game,
            selectedSourceId: nil,
            mode: .attack
        )

        XCTAssertEqual(guide.actionableIds, ["alaska", "alberta"])
        XCTAssertFalse(guide.actionableIds.contains("northwest_territory"))
    }

    func testSelectionGuideMovesFromAttackSourcesToAdjacentEnemyTargets() {
        let game = gameplayGame(revision: 1, phase: .attack, reinforcements: 0)

        let sourceGuide = GameplaySelectionGuide.make(
            game: game,
            selectedSourceId: nil,
            mode: .attack
        )
        let targetGuide = GameplaySelectionGuide.make(
            game: game,
            selectedSourceId: "alaska",
            mode: .attack
        )

        XCTAssertEqual(sourceGuide.actionableIds, ["alaska"])
        XCTAssertEqual(targetGuide.targetIds, ["northwest_territory"])
        XCTAssertEqual(targetGuide.actionableIds, ["alaska", "northwest_territory"])
    }

    func testSelectionGuideOffersOwnedFortifyDestinationsButLeavesConnectivityToServer() {
        let game = gameplayGame(revision: 1, phase: .attack, reinforcements: 0)

        let guide = GameplaySelectionGuide.make(
            game: game,
            selectedSourceId: "alaska",
            mode: .fortify
        )

        XCTAssertEqual(guide.targetIds, ["alberta"])
        XCTAssertFalse(guide.targetIds.contains("northwest_territory"))
    }

    func testSelectionGuideHasNoActionsAfterActionPhaseCompletes() {
        let game = gameplayGame(revision: 1, phase: .done, reinforcements: 0)

        let guide = GameplaySelectionGuide.make(
            game: game,
            selectedSourceId: nil,
            mode: .attack
        )

        XCTAssertTrue(guide.actionableIds.isEmpty)
    }

    private func gameplayGame(
        revision: Int,
        phase: TurnPhase,
        reinforcements: Int,
        status: GameStatus = .active,
        winnerId: String? = nil,
        currentPlayerId: String? = "p1",
        yourTurn: Bool = true,
        dashboard: GameplayDashboard? = nil,
        practice: Bool = false
    ) -> GameplayGame {
        GameplayGame(
            id: "game-play",
            revision: revision,
            practice: practice,
            status: status,
            winnerId: winnerId,
            dayNumber: 0,
            turnOrder: ["p1", "p2"],
            currentPlayerId: currentPlayerId,
            mySeats: ["p1"],
            isCreator: true,
            yourTurn: yourTurn,
            dashboard: dashboard,
            healthLogging: nil,
            exercises: nil,
            phase: phase,
            windowExpiresAt: "2026-08-03T02:00:00.000Z",
            nextSessionOpensAt: nil,
            schedule: GameSchedule(
                timezone: "America/Denver",
                dailyStartMinuteOfDay: 1140,
                playerWindowMinutes: 720,
                moveDeadlineAt: "2026-08-03T02:00:00.000Z",
                nextSessionOpensAt: nil,
                missedTurnPolicy: "auto_resolve"
            ),
            players: [
                GameplayPlayer(
                    id: "p1",
                    name: "Ray",
                    status: .active,
                    color: "#6ea8fe",
                    pendingReinforcements: reinforcements,
                    pendingEliminationReward: 0,
                    note: "",
                    claimed: true,
                    healthProgress: nil
                ),
                GameplayPlayer(
                    id: "p2",
                    name: "Tess",
                    status: .active,
                    color: "#69d39b",
                    pendingReinforcements: 0,
                    pendingEliminationReward: 0,
                    note: "",
                    claimed: true,
                    healthProgress: nil
                ),
            ],
            continents: [GameplayContinent(id: "north_america", label: "North America", bonus: 5)],
            territories: [
                GameplayTerritory(
                    id: "alaska",
                    owner: "p1",
                    armies: 4,
                    continent: "north_america",
                    neighbors: ["northwest_territory"],
                    color: "#6ea8fe"
                ),
                GameplayTerritory(
                    id: "northwest_territory",
                    owner: "p2",
                    armies: 2,
                    continent: "north_america",
                    neighbors: ["alaska"],
                    color: "#69d39b"
                ),
                GameplayTerritory(
                    id: "alberta",
                    owner: "p1",
                    armies: 1,
                    continent: "north_america",
                    neighbors: ["northwest_territory"],
                    color: "#6ea8fe"
                ),
            ]
        )
    }

    private func gameplayDashboard(
        cardCount: Int = 0,
        canTrade: Bool = false,
        turnSummary: GameplayTurnSummary? = nil
    ) -> GameplayDashboard {
        GameplayDashboard(
            playerId: "p1",
            availableReinforcements: nil,
            turnStart: nil,
            cards: GameplayCards(
                hand: (0..<cardCount).map {
                    TerritoryCard(id: "card-\($0)", territoryId: "territory_\($0)", earnedDay: 0)
                },
                tradeSize: 3,
                tradeReward: 3,
                canTrade: canTrade
            ),
            turnSummary: turnSummary,
            exercise: nil
        )
    }
}

private actor OneRefreshGameplaySyncSleeper: GameplaySyncSleeping {
    private var hasAllowedRefresh = false

    func sleep() async throws {
        if hasAllowedRefresh {
            throw CancellationError()
        }
        hasAllowedRefresh = true
    }
}
