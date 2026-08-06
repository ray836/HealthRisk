import XCTest
@testable import HealthRisk

@MainActor
final class GamesStoreTests: XCTestCase {
    func testAutomaticSynchronizationClearsStaleYourTurnBadge() async {
        let stale = gameSummary(currentPlayerId: "p1", yourTurn: true)
        let current = gameSummary(currentPlayerId: nil, yourTurn: false)
        let api = MockHealthRiskAPI(
            gamesResults: [
                .success(ListGamesResponse(games: [stale])),
                .success(ListGamesResponse(games: [current])),
            ]
        )
        let store = GamesStore(
            api: api,
            syncSleeper: OneRefreshGamesSyncSleeper()
        )

        await store.synchronize()

        XCTAssertEqual(store.games, [current])
        XCTAssertFalse(store.games[0].yourTurn)
        XCTAssertNil(store.games[0].currentPlayerId)
        let callCount = await api.recordedListGamesCallCount()
        XCTAssertEqual(callCount, 2)
    }

    func testCreateGameSendsRequestAndRefreshesLibrary() async {
        let summary = GameSummary(
            id: "game-new",
            status: .setup,
            practice: false,
            isCreator: true,
            myPlayerIds: ["p1"],
            playerCount: 1,
            lobbyCapacity: 4,
            dayNumber: 0,
            currentPlayerId: nil,
            yourTurn: false,
            winnerId: nil,
            playerNames: ["ray"],
            inviteLink: "https://health-risk-ecru.vercel.app/join/game-new",
            deepLink: "/game/game-new"
        )
        let api = MockHealthRiskAPI(
            gamesResult: .success(ListGamesResponse(games: [summary])),
            createGameResult: .success(createdGame(id: "game-new", practice: false, status: .setup))
        )
        let store = GamesStore(api: api)
        let request = CreateGameRequest(practice: false)

        let succeeded = await store.createGame(request)

        XCTAssertTrue(succeeded)
        XCTAssertEqual(store.games, [summary])
        XCTAssertNil(store.createError)
        XCTAssertFalse(store.isCreating)
        let recordedRequests = await api.recordedCreateGameRequests()
        XCTAssertEqual(recordedRequests, [request])
    }

    func testCreateGamePublishesServerErrorWithoutRefreshing() async {
        let serverError = APIError(
            statusCode: 400,
            code: "bad_health_rules",
            message: "The selected health rules are invalid.",
            requestId: "request-creation",
            retryable: false
        )
        let api = MockHealthRiskAPI(createGameResult: .failure(serverError))
        let store = GamesStore(api: api)

        let succeeded = await store.createGame(CreateGameRequest(practice: false))

        XCTAssertFalse(succeeded)
        XCTAssertEqual(store.createError, serverError)
        XCTAssertTrue(store.games.isEmpty)
        XCTAssertFalse(store.isCreating)
    }

    func testJoinGameSendsNormalizedIdAndRefreshesLibrary() async {
        let summary = GameSummary(
            id: "game-jen36x",
            status: .setup,
            practice: false,
            isCreator: false,
            myPlayerIds: ["p2"],
            playerCount: 2,
            lobbyCapacity: 10,
            dayNumber: 0,
            currentPlayerId: nil,
            yourTurn: false,
            winnerId: nil,
            playerNames: ["creator", "ray"],
            inviteLink: "/join/game-jen36x",
            deepLink: "/game/game-jen36x"
        )
        let joined = JoinGameResponse(
            seat: "p2",
            game: createdGame(id: "game-jen36x", practice: false, status: .setup)
        )
        let api = MockHealthRiskAPI(
            gamesResult: .success(ListGamesResponse(games: [summary])),
            joinGameResult: .success(joined)
        )
        let store = GamesStore(api: api)

        let succeeded = await store.joinGame(gameId: "game-jen36x")

        XCTAssertTrue(succeeded)
        XCTAssertEqual(store.games, [summary])
        XCTAssertNil(store.joinError)
        XCTAssertFalse(store.isJoining)
        let joinedGameIds = await api.recordedJoinedGameIds()
        XCTAssertEqual(joinedGameIds, ["game-jen36x"])
    }

    func testJoinGamePublishesServerErrorWithoutRefreshing() async {
        let serverError = APIError(
            statusCode: 404,
            code: "no_game",
            message: "Unknown game",
            requestId: "request-join",
            retryable: false
        )
        let api = MockHealthRiskAPI(joinGameResult: .failure(serverError))
        let store = GamesStore(api: api)

        let succeeded = await store.joinGame(gameId: "game-missing")

        XCTAssertFalse(succeeded)
        XCTAssertEqual(store.joinError, serverError)
        XCTAssertTrue(store.games.isEmpty)
        XCTAssertFalse(store.isJoining)
    }

    func testJoinCodeAcceptsShortCodeFullIdAndInviteLink() {
        XCTAssertEqual(GameJoinCode.displayCode(from: "game-jen36x"), "JEN36X")
        XCTAssertEqual(GameJoinCode.gameID(from: " JEN36X "), "game-jen36x")
        XCTAssertEqual(GameJoinCode.gameID(from: "game-JEN36X"), "game-jen36x")
        XCTAssertEqual(
            GameJoinCode.gameID(from: "https://health-risk-ecru.vercel.app/join/game-jen36x"),
            "game-jen36x"
        )
        XCTAssertNil(GameJoinCode.gameID(from: "too-short"))
        XCTAssertNil(GameJoinCode.gameID(from: "ABC!23"))
    }

    private func gameSummary(currentPlayerId: String?, yourTurn: Bool) -> GameSummary {
        GameSummary(
            id: "game-practice",
            status: .active,
            practice: true,
            isCreator: true,
            myPlayerIds: ["p1", "p2"],
            playerCount: 2,
            lobbyCapacity: 2,
            dayNumber: 1,
            currentPlayerId: currentPlayerId,
            yourTurn: yourTurn,
            winnerId: nil,
            playerNames: ["Player 1", "Player 2"],
            inviteLink: nil,
            deepLink: "/game/game-practice"
        )
    }

    private func createdGame(id: String, practice: Bool, status: GameStatus) -> GameView {
        GameView(
            id: id,
            revision: 1,
            status: status,
            practice: practice,
            yourTurn: false,
            players: [],
            territories: [],
            chatMessages: [],
            schedule: nil
        )
    }
}

private actor OneRefreshGamesSyncSleeper: GamesSyncSleeping {
    private var hasRefreshed = false

    func sleep() async throws {
        if hasRefreshed {
            throw CancellationError()
        }
        hasRefreshed = true
    }
}
