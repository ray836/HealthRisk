import XCTest
@testable import HealthRisk

@MainActor
final class WaitingRoomStoreTests: XCTestCase {
    func testSynchronizationDetectsWhenAnotherPlayerStartsTheGame() async {
        let waiting = lobbyGame(revision: 7)
        let active = lobbyGame(revision: 8, status: .active)
        let api = MockHealthRiskAPI(
            gameResults: [.success(waiting), .success(active)]
        )
        let store = WaitingRoomStore(
            gameId: waiting.id,
            api: api,
            syncSleeper: OneRefreshWaitingRoomSyncSleeper()
        )

        await store.synchronize()

        let callCount = await api.recordedGetGameCallCount()
        XCTAssertEqual(store.game, active)
        XCTAssertEqual(callCount, 2)
    }

    func testRefreshPreservesUnsubmittedChoicesWhenOnlyGameRevisionChanges() async {
        let initial = lobbyGame(revision: 4, healthRulesVersion: 2)
        let refreshed = lobbyGame(revision: 5, healthRulesVersion: 2, playerCount: 2)
        let api = MockHealthRiskAPI(gameResults: [.success(initial), .success(refreshed)])
        let store = WaitingRoomStore(gameId: initial.id, api: api)

        await store.load()
        store.toggleGoal("running")
        await store.load()

        XCTAssertEqual(store.game?.revision, 5)
        XCTAssertEqual(store.selectedGoalKeys, ["running"])
        XCTAssertTrue(store.choicesHaveChanges)
    }

    func testRefreshResetsUnsubmittedChoicesWhenHealthRulesChange() async {
        let initial = lobbyGame(revision: 4, healthRulesVersion: 2)
        let refreshed = lobbyGame(
            revision: 5,
            healthRulesVersion: 3,
            goalLabel: "Walking"
        )
        let api = MockHealthRiskAPI(gameResults: [.success(initial), .success(refreshed)])
        let store = WaitingRoomStore(gameId: initial.id, api: api)

        await store.load()
        store.toggleGoal("running")
        await store.load()

        XCTAssertEqual(store.game?.healthRulesVersion, 3)
        XCTAssertEqual(store.game?.exercises.first?.label, "Walking")
        XCTAssertTrue(store.selectedGoalKeys.isEmpty)
        XCTAssertFalse(store.choicesHaveChanges)
    }

    func testLoadsGoalsAndSubmitsSelectedChoicesWithReviewedRulesVersion() async {
        let initial = lobbyGame(revision: 4, healthRulesVersion: 2)
        let submitted = lobbyGame(
            revision: 5,
            healthRulesVersion: 2,
            selections: ["running"],
            hasSubmitted: true
        )
        let api = MockHealthRiskAPI(
            gameResult: .success(initial),
            choicesResult: .success(LobbyGameMutationResponse(game: submitted))
        )
        let store = WaitingRoomStore(gameId: initial.id, api: api)

        await store.load()
        store.toggleGoal("running")
        let succeeded = await store.submitChoices()

        XCTAssertTrue(succeeded)
        XCTAssertEqual(store.game?.revision, 5)
        XCTAssertEqual(store.selectedGoalKeys, ["running"])
        XCTAssertFalse(store.choicesHaveChanges)
        let submissions = await api.recordedChoicesSubmissions()
        XCTAssertEqual(
            submissions,
            [
                MockHealthRiskAPI.RecordedChoicesSubmission(
                    gameId: "game-lobby",
                    request: LobbyHealthChoicesRequest(
                        revision: 4,
                        healthRulesVersion: 2,
                        exerciseKeys: ["running"]
                    )
                ),
            ]
        )
    }

    func testCreatorRuleUpdateReplacesGameAndResetsSelections() async {
        let initial = lobbyGame(revision: 4, selections: ["running"], hasSubmitted: true)
        let updated = lobbyGame(revision: 5, goalLabel: "Walking")
        let api = MockHealthRiskAPI(
            gameResult: .success(initial),
            rulesUpdateResult: .success(LobbyGameMutationResponse(game: updated))
        )
        let store = WaitingRoomStore(gameId: initial.id, api: api)
        await store.load()
        let request = HealthRulesUpdateRequest(
            revision: initial.revision,
            exercises: updated.exercises,
            categoryTroopCaps: updated.categoryTroopCaps,
            dailyTotalTroopCap: updated.dailyTotalTroopCap
        )

        let succeeded = await store.updateRules(request)

        XCTAssertTrue(succeeded)
        XCTAssertEqual(store.game?.exercises.first?.label, "Walking")
        XCTAssertTrue(store.selectedGoalKeys.isEmpty)
        let updates = await api.recordedRulesUpdates()
        XCTAssertEqual(
            updates,
            [MockHealthRiskAPI.RecordedRulesUpdate(gameId: "game-lobby", request: request)]
        )
    }

    func testCreatorCanCancelLobbyWithLatestRevision() async {
        let initial = lobbyGame(revision: 7)
        let api = MockHealthRiskAPI(
            gameResult: .success(initial),
            leaveGameResult: .success(
                LeaveGameResponse(
                    ok: true,
                    activeMultiplayerGameId: nil,
                    game: cancelledGame(id: initial.id)
                )
            )
        )
        let store = WaitingRoomStore(gameId: initial.id, api: api)
        await store.load()

        let succeeded = await store.exitLobby()

        XCTAssertTrue(succeeded)
        XCTAssertNil(store.game)
        XCTAssertNil(store.exitError)
        XCTAssertFalse(store.isExitingLobby)
        let exits = await api.recordedGameExits()
        XCTAssertEqual(
            exits,
            [
                MockHealthRiskAPI.RecordedGameExit(
                    gameId: "game-lobby",
                    request: RevisionRequest(revision: 7)
                ),
            ]
        )
    }

    func testCreatorCanStartWithTwoPlayersAndLatestRevision() async {
        let initial = lobbyGame(
            revision: 7,
            selections: ["running"],
            hasSubmitted: true,
            playerCount: 2,
            allSubmitted: true
        )
        let api = MockHealthRiskAPI(
            gameResult: .success(initial),
            startGameResult: .success(
                GameMutationResponse(game: activeGame(id: initial.id))
            )
        )
        let store = WaitingRoomStore(gameId: initial.id, api: api)
        await store.load()

        let succeeded = await store.startGame()

        XCTAssertTrue(succeeded)
        XCTAssertNil(store.game)
        XCTAssertNil(store.startError)
        XCTAssertFalse(store.isStartingGame)
        let starts = await api.recordedGameStarts()
        XCTAssertEqual(
            starts,
            [
                MockHealthRiskAPI.RecordedGameStart(
                    gameId: "game-lobby",
                    request: RevisionRequest(revision: 7)
                ),
            ]
        )
    }

    func testStartGamePublishesServerErrorAndKeepsLobbyVisible() async {
        let initial = lobbyGame(revision: 7, playerCount: 2)
        let serverError = APIError(
            statusCode: 409,
            code: "health_votes_incomplete",
            message: "Waiting for players to review the health goals",
            requestId: "request-start",
            retryable: false
        )
        let api = MockHealthRiskAPI(
            gameResult: .success(initial),
            startGameResult: .failure(serverError)
        )
        let store = WaitingRoomStore(gameId: initial.id, api: api)
        await store.load()

        let succeeded = await store.startGame()

        XCTAssertFalse(succeeded)
        XCTAssertEqual(store.game, initial)
        XCTAssertEqual(store.startError, serverError)
        XCTAssertFalse(store.isStartingGame)
    }

    func testCancelLobbyPublishesServerErrorAndKeepsGameVisible() async {
        let initial = lobbyGame(revision: 7)
        let serverError = APIError(
            statusCode: 409,
            code: "stale_game",
            message: "Refresh and try again.",
            requestId: "request-cancel",
            retryable: false
        )
        let api = MockHealthRiskAPI(
            gameResult: .success(initial),
            leaveGameResult: .failure(serverError)
        )
        let store = WaitingRoomStore(gameId: initial.id, api: api)
        await store.load()

        let succeeded = await store.exitLobby()

        XCTAssertFalse(succeeded)
        XCTAssertEqual(store.game, initial)
        XCTAssertEqual(store.exitError, serverError)
        XCTAssertFalse(store.isExitingLobby)
    }

    private func cancelledGame(id: String) -> GameView {
        GameView(
            id: id,
            revision: 8,
            status: .cancelled,
            practice: false,
            yourTurn: false,
            players: [],
            territories: [],
            chatMessages: [],
            schedule: nil
        )
    }

    private func activeGame(id: String) -> GameView {
        GameView(
            id: id,
            revision: 8,
            status: .active,
            practice: false,
            yourTurn: true,
            players: [],
            territories: [],
            chatMessages: [],
            schedule: nil
        )
    }

    private func lobbyGame(
        revision: Int,
        status: GameStatus = .setup,
        healthRulesVersion: Int? = nil,
        goalLabel: String = "Running",
        selections: [String] = [],
        hasSubmitted: Bool = false,
        playerCount: Int = 1,
        allSubmitted: Bool? = nil
    ) -> LobbyGameView {
        let key = goalLabel.lowercased()
        let players = (1...playerCount).map {
            LobbyPlayer(id: "p\($0)", name: "Player \($0)", claimed: true)
        }
        let everyoneSubmitted = allSubmitted ?? (hasSubmitted && playerCount == 1)
        let submittedPlayerIds = everyoneSubmitted
            ? players.map(\.id)
            : (hasSubmitted ? ["p1"] : [])
        return LobbyGameView(
            id: "game-lobby",
            revision: revision,
            status: status,
            practice: false,
            isCreator: true,
            claimedPlayerCount: playerCount,
            lobbyCapacity: 10,
            players: players,
            exercises: [
                HealthGoalRule(
                    key: key,
                    label: goalLabel,
                    unitLabel: "mile",
                    category: .movement,
                    trackingType: .quantity,
                    troopsPerUnit: 1,
                    dailyUnitCap: 5
                ),
            ],
            categoryTroopCaps: ["movement": 5],
            healthRuleGovernance: .creator,
            healthRulesVersion: healthRulesVersion ?? revision,
            dailyTotalTroopCap: 10,
            lobbyHealthVoting: LobbyHealthVoting(
                enabled: true,
                voteCounts: selections.isEmpty ? [:] : [key: 1],
                submittedPlayerIds: submittedPlayerIds,
                includedExerciseKeys: selections,
                submissionCount: submittedPlayerIds.count,
                requiredSubmissions: playerCount,
                allSubmitted: everyoneSubmitted,
                hasSubmitted: hasSubmitted,
                mySelections: selections
            )
        )
    }
}

private actor OneRefreshWaitingRoomSyncSleeper: WaitingRoomSyncSleeping {
    private var hasRefreshed = false

    func sleep() async throws {
        if hasRefreshed {
            throw CancellationError()
        }
        hasRefreshed = true
    }
}
