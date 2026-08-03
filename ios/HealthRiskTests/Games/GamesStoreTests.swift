import XCTest
@testable import HealthRisk

@MainActor
final class GamesStoreTests: XCTestCase {
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
            statusCode: 409,
            code: "active_multiplayer_game",
            message: "You are already playing an active multiplayer game.",
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
