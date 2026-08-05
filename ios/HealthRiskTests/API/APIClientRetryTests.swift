import Foundation
import XCTest
@testable import HealthRisk

final class APIClientRetryTests: XCTestCase {
    func testMutationRetryReusesItsIdempotencyKeyAndNextMutationGetsANewKey() async throws {
        let session = MockURLSession(outcomes: [
            .networkFailure,
            .response(status: 200, headers: [:], body: authResponseData),
            .response(status: 200, headers: [:], body: authResponseData),
        ])
        let client = APIClient(
            baseURL: URL(string: "https://healthrisk.example")!,
            session: session,
            retryPolicy: RetryPolicy(maximumAttempts: 2, delay: .zero),
            sleeper: ImmediateSleeper()
        )
        let credentials = AuthRequest(username: "ray", password: "password123")

        _ = try await client.login(credentials)
        _ = try await client.login(credentials)

        let requests = await session.recordedRequests()
        XCTAssertEqual(requests.count, 3)
        let firstKey = try XCTUnwrap(requests[0].value(forHTTPHeaderField: "Idempotency-Key"))
        let retryKey = try XCTUnwrap(requests[1].value(forHTTPHeaderField: "Idempotency-Key"))
        let nextMutationKey = try XCTUnwrap(requests[2].value(forHTTPHeaderField: "Idempotency-Key"))
        XCTAssertEqual(firstKey, retryKey)
        XCTAssertNotEqual(retryKey, nextMutationKey)
        XCTAssertNotNil(UUID(uuidString: firstKey))
        XCTAssertNotNil(UUID(uuidString: nextMutationKey))
    }

    func testServerErrorIncludesRequestIdAndRetryableFlag() async {
        let body = Data(
            #"{"error":"service_busy","message":"Please try again.","requestId":"server-request-7","retryable":true}"#.utf8
        )
        let session = MockURLSession(outcomes: [
            .response(status: 503, headers: ["X-Request-Id": "header-request"], body: body),
        ])
        let client = APIClient(
            baseURL: URL(string: "https://healthrisk.example")!,
            session: session,
            retryPolicy: RetryPolicy(maximumAttempts: 1, delay: .zero),
            sleeper: ImmediateSleeper()
        )

        do {
            _ = try await client.login(AuthRequest(username: "ray", password: "password123"))
            XCTFail("Expected the request to fail")
        } catch let error as APIError {
            XCTAssertEqual(error.statusCode, 503)
            XCTAssertEqual(error.code, "service_busy")
            XCTAssertEqual(error.requestId, "server-request-7")
            XCTAssertTrue(error.retryable)
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testCreateGameRetriesWithOneIdempotencyKeyAndDecodesCreatedGame() async throws {
        let createdGame = Data(
            #"{"id":"game-native","revision":1,"status":"setup","practice":false,"players":[],"territories":[],"chatMessages":[]}"#.utf8
        )
        let session = MockURLSession(outcomes: [
            .networkFailure,
            .response(status: 201, headers: [:], body: createdGame),
        ])
        let client = APIClient(
            baseURL: URL(string: "https://healthrisk.example")!,
            session: session,
            retryPolicy: RetryPolicy(maximumAttempts: 2, delay: .zero),
            sleeper: ImmediateSleeper()
        )

        let game = try await client.createGame(CreateGameRequest(practice: false))

        XCTAssertEqual(game.id, "game-native")
        XCTAssertEqual(game.status, .setup)

        let requests = await session.recordedRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].httpMethod, "POST")
        XCTAssertEqual(requests[0].url?.path, "/api/games")
        XCTAssertEqual(
            requests[0].value(forHTTPHeaderField: "Idempotency-Key"),
            requests[1].value(forHTTPHeaderField: "Idempotency-Key")
        )
        XCTAssertNotNil(
            UUID(uuidString: try XCTUnwrap(requests[0].value(forHTTPHeaderField: "Idempotency-Key")))
        )
        let body = try XCTUnwrap(requests[0].httpBody)
        XCTAssertEqual(try JSONDecoder().decode(CreateGameRequest.self, from: body), CreateGameRequest(practice: false))
    }

    func testJoinGameRetriesWithOneIdempotencyKeyAndNoRequestBody() async throws {
        let joinedGame = Data(
            #"{"seat":"p2","game":{"id":"game-jen36x","revision":2,"status":"setup","practice":false,"yourTurn":false,"players":[],"territories":[],"chatMessages":[]}}"#.utf8
        )
        let session = MockURLSession(outcomes: [
            .networkFailure,
            .response(status: 200, headers: [:], body: joinedGame),
        ])
        let client = APIClient(
            baseURL: URL(string: "https://healthrisk.example")!,
            session: session,
            retryPolicy: RetryPolicy(maximumAttempts: 2, delay: .zero),
            sleeper: ImmediateSleeper()
        )

        let response = try await client.joinGame(gameId: "game-jen36x")

        XCTAssertEqual(response.seat, "p2")
        XCTAssertEqual(response.game.id, "game-jen36x")
        let requests = await session.recordedRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].httpMethod, "POST")
        XCTAssertEqual(requests[0].url?.path, "/api/games/game-jen36x/join")
        XCTAssertNil(requests[0].httpBody)
        XCTAssertEqual(
            requests[0].value(forHTTPHeaderField: "Idempotency-Key"),
            requests[1].value(forHTTPHeaderField: "Idempotency-Key")
        )
        XCTAssertNotNil(
            UUID(uuidString: try XCTUnwrap(requests[0].value(forHTTPHeaderField: "Idempotency-Key")))
        )
    }

    func testStartGameRetriesWithSameRevisionAndIdempotencyKey() async throws {
        let responseData = Data(
            #"{"game":{"id":"game-lobby","revision":8,"status":"active","practice":false,"yourTurn":true,"players":[],"territories":[],"chatMessages":[]}}"#.utf8
        )
        let session = MockURLSession(outcomes: [
            .networkFailure,
            .response(status: 200, headers: [:], body: responseData),
        ])
        let client = APIClient(
            baseURL: URL(string: "https://healthrisk.example")!,
            session: session,
            retryPolicy: RetryPolicy(maximumAttempts: 2, delay: .zero),
            sleeper: ImmediateSleeper()
        )
        let revision = RevisionRequest(revision: 7)

        let response = try await client.startGame(gameId: "game-lobby", request: revision)

        XCTAssertEqual(response.game.status, .active)
        let requests = await session.recordedRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].url?.path, "/api/games/game-lobby/start")
        XCTAssertEqual(
            requests[0].value(forHTTPHeaderField: "Idempotency-Key"),
            requests[1].value(forHTTPHeaderField: "Idempotency-Key")
        )
        XCTAssertEqual(
            try JSONDecoder().decode(RevisionRequest.self, from: XCTUnwrap(requests[0].httpBody)),
            revision
        )
    }

    func testHealthRuleUpdateRetriesWithSameRevisionAndIdempotencyKey() async throws {
        let session = MockURLSession(outcomes: [
            .networkFailure,
            .response(status: 200, headers: [:], body: lobbyMutationResponseData),
        ])
        let client = APIClient(
            baseURL: URL(string: "https://healthrisk.example")!,
            session: session,
            retryPolicy: RetryPolicy(maximumAttempts: 2, delay: .zero),
            sleeper: ImmediateSleeper()
        )
        let rule = HealthGoalRule(
            key: "walking",
            label: "Walking",
            unitLabel: "mile",
            category: .movement,
            trackingType: .quantity,
            troopsPerUnit: 1,
            dailyUnitCap: 5
        )
        let request = HealthRulesUpdateRequest(
            revision: 4,
            exercises: [rule],
            categoryTroopCaps: ["movement": 5],
            dailyTotalTroopCap: 10
        )

        let response = try await client.updateLobbyHealthRules(gameId: "game-lobby", request: request)

        XCTAssertEqual(response.game.revision, 5)
        XCTAssertEqual(response.game.exercises.first?.label, "Walking")
        let requests = await session.recordedRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].url?.path, "/api/games/game-lobby/health-rules/propose")
        XCTAssertEqual(
            requests[0].value(forHTTPHeaderField: "Idempotency-Key"),
            requests[1].value(forHTTPHeaderField: "Idempotency-Key")
        )
        XCTAssertEqual(
            try JSONDecoder().decode(HealthRulesUpdateRequest.self, from: XCTUnwrap(requests[0].httpBody)),
            request
        )
    }

    func testCancelLobbyRetriesWithSameRevisionAndIdempotencyKey() async throws {
        let responseData = Data(
            #"{"ok":true,"activeMultiplayerGameId":null,"game":{"id":"game-lobby","revision":8,"status":"cancelled","practice":false,"yourTurn":false,"players":[],"territories":[],"chatMessages":[]}}"#.utf8
        )
        let session = MockURLSession(outcomes: [
            .networkFailure,
            .response(status: 200, headers: [:], body: responseData),
        ])
        let client = APIClient(
            baseURL: URL(string: "https://healthrisk.example")!,
            session: session,
            retryPolicy: RetryPolicy(maximumAttempts: 2, delay: .zero),
            sleeper: ImmediateSleeper()
        )
        let revision = RevisionRequest(revision: 7)

        let response = try await client.leaveGame(gameId: "game-lobby", request: revision)

        XCTAssertTrue(response.ok)
        XCTAssertNil(response.activeMultiplayerGameId)
        XCTAssertEqual(response.game.status, .cancelled)
        let requests = await session.recordedRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].url?.path, "/api/games/game-lobby/leave")
        XCTAssertEqual(
            requests[0].value(forHTTPHeaderField: "Idempotency-Key"),
            requests[1].value(forHTTPHeaderField: "Idempotency-Key")
        )
        XCTAssertEqual(
            try JSONDecoder().decode(RevisionRequest.self, from: XCTUnwrap(requests[0].httpBody)),
            revision
        )
    }

    func testDeletePracticeGameRetriesWithSameRevisionAndIdempotencyKey() async throws {
        let responseData = Data(#"{"ok":true}"#.utf8)
        let session = MockURLSession(outcomes: [
            .networkFailure,
            .response(status: 200, headers: [:], body: responseData),
        ])
        let client = APIClient(
            baseURL: URL(string: "https://healthrisk.example")!,
            session: session,
            retryPolicy: RetryPolicy(maximumAttempts: 2, delay: .zero),
            sleeper: ImmediateSleeper()
        )
        let revision = RevisionRequest(revision: 7)

        let response = try await client.deletePracticeGame(
            gameId: "game-practice",
            request: revision
        )

        XCTAssertTrue(response.ok)
        let requests = await session.recordedRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].url?.path, "/api/games/game-practice/delete")
        XCTAssertEqual(
            requests[0].value(forHTTPHeaderField: "Idempotency-Key"),
            requests[1].value(forHTTPHeaderField: "Idempotency-Key")
        )
        XCTAssertEqual(
            try JSONDecoder().decode(RevisionRequest.self, from: XCTUnwrap(requests[0].httpBody)),
            revision
        )
    }

    func testReinforcementRetriesSameAuthoritativeMutationAndAppliesServerGame() async throws {
        let session = MockURLSession(outcomes: [
            .networkFailure,
            .response(status: 200, headers: [:], body: gameplayMutationResponseData),
        ])
        let client = APIClient(
            baseURL: URL(string: "https://healthrisk.example")!,
            session: session,
            retryPolicy: RetryPolicy(maximumAttempts: 2, delay: .zero),
            sleeper: ImmediateSleeper()
        )
        let request = ReinforcementRequest(
            revision: 7,
            placements: [ReinforcementPlacement(territoryId: "alaska", count: 2)]
        )

        let response = try await client.reinforce(gameId: "game-play", request: request)

        XCTAssertEqual(response.game.revision, 8)
        XCTAssertEqual(response.game.currentPlayerReinforcements, 3)
        XCTAssertEqual(response.game.territories.first?.armies, 6)
        let requests = await session.recordedRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].httpMethod, "POST")
        XCTAssertEqual(requests[0].url?.path, "/api/games/game-play/reinforce")
        XCTAssertEqual(
            requests[0].value(forHTTPHeaderField: "Idempotency-Key"),
            requests[1].value(forHTTPHeaderField: "Idempotency-Key")
        )
        XCTAssertNotNil(
            UUID(uuidString: try XCTUnwrap(requests[0].value(forHTTPHeaderField: "Idempotency-Key")))
        )
        XCTAssertEqual(
            try JSONDecoder().decode(ReinforcementRequest.self, from: XCTUnwrap(requests[0].httpBody)),
            request
        )
    }

    func testCardTradeRetriesWithSameRevisionAndIdempotencyKey() async throws {
        let mutationJSON = try XCTUnwrap(String(data: gameplayMutationResponseData, encoding: .utf8))
        let responseData = Data(
            mutationJSON.replacingOccurrences(
                of: "{\"game\":",
                with: "{\"remainingBank\":6,\"remainingCards\":0,\"troopsAwarded\":3,\"game\":"
            ).utf8
        )
        let session = MockURLSession(outcomes: [
            .networkFailure,
            .response(status: 200, headers: [:], body: responseData),
        ])
        let client = APIClient(
            baseURL: URL(string: "https://healthrisk.example")!,
            session: session,
            retryPolicy: RetryPolicy(maximumAttempts: 2, delay: .zero),
            sleeper: ImmediateSleeper()
        )
        let request = RevisionRequest(revision: 7)

        let response = try await client.tradeCards(gameId: "game-play", request: request)

        XCTAssertEqual(response.troopsAwarded, 3)
        XCTAssertEqual(response.remainingCards, 0)
        let requests = await session.recordedRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].url?.path, "/api/games/game-play/cards/trade")
        XCTAssertEqual(
            requests[0].value(forHTTPHeaderField: "Idempotency-Key"),
            requests[1].value(forHTTPHeaderField: "Idempotency-Key")
        )
        XCTAssertEqual(
            try JSONDecoder().decode(RevisionRequest.self, from: XCTUnwrap(requests[0].httpBody)),
            request
        )
    }

    private var authResponseData: Data {
        Data(#"{"token":"token","user":{"id":"u1","username":"ray"}}"#.utf8)
    }

    private var lobbyMutationResponseData: Data {
        Data(
            #"{"game":{"id":"game-lobby","revision":5,"status":"setup","practice":false,"isCreator":true,"claimedPlayerCount":1,"lobbyCapacity":4,"players":[{"id":"p1","name":"ray","claimed":true}],"exercises":[{"key":"walking","label":"Walking","unitLabel":"mile","category":"movement","trackingType":"quantity","troopsPerUnit":1,"dailyUnitCap":5}],"categoryTroopCaps":{"movement":5},"healthRuleGovernance":"creator","healthRulesVersion":3,"dailyTotalTroopCap":10,"lobbyHealthVoting":{"enabled":true,"voteCounts":{},"submittedPlayerIds":[],"includedExerciseKeys":[],"submissionCount":0,"requiredSubmissions":1,"allSubmitted":false,"hasSubmitted":false,"mySelections":[]}}}"#.utf8
        )
    }

    private var gameplayMutationResponseData: Data {
        Data(
            ##"{"game":{"id":"game-play","revision":8,"practice":false,"status":"active","winnerId":null,"dayNumber":0,"turnOrder":["p1","p2"],"currentPlayerId":"p1","mySeats":["p1"],"isCreator":true,"yourTurn":true,"phase":"reinforce","windowExpiresAt":"2026-08-03T02:00:00.000Z","nextSessionOpensAt":null,"schedule":{"timezone":"America/Denver","dailyStartMinuteOfDay":1140,"playerWindowMinutes":720,"moveDeadlineAt":"2026-08-03T02:00:00.000Z","nextSessionOpensAt":null,"missedTurnPolicy":"auto_resolve"},"players":[{"id":"p1","name":"Ray","status":"active","color":"#6ea8fe","pendingReinforcements":3,"pendingEliminationReward":0,"note":"","claimed":true},{"id":"p2","name":"Tess","status":"active","color":"#69d39b","pendingReinforcements":0,"pendingEliminationReward":0,"note":"","claimed":true}],"continents":[{"id":"north_america","label":"North America","bonus":5}],"territories":[{"id":"alaska","owner":"p1","armies":6,"continent":"north_america","neighbors":["northwest_territory"],"color":"#6ea8fe"},{"id":"northwest_territory","owner":"p2","armies":2,"continent":"north_america","neighbors":["alaska"],"color":"#69d39b"}]}}"##.utf8
        )
    }
}

private struct ImmediateSleeper: RetrySleeping {
    func sleep(for duration: Duration) async {}
}

private actor MockURLSession: URLSessioning {
    enum Outcome: Sendable {
        case networkFailure
        case response(status: Int, headers: [String: String], body: Data)
    }

    struct NetworkFailure: Error {}

    private var outcomes: [Outcome]
    private var requests: [URLRequest] = []

    init(outcomes: [Outcome]) {
        self.outcomes = outcomes
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        guard !outcomes.isEmpty else { throw NetworkFailure() }
        let outcome = outcomes.removeFirst()

        switch outcome {
        case .networkFailure:
            throw NetworkFailure()
        case let .response(status, headers, body):
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: headers
            )!
            return (body, response)
        }
    }

    func recordedRequests() -> [URLRequest] { requests }
}
