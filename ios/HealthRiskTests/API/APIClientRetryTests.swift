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

    private var authResponseData: Data {
        Data(#"{"token":"token","user":{"id":"u1","username":"ray"}}"#.utf8)
    }

    private var lobbyMutationResponseData: Data {
        Data(
            #"{"game":{"id":"game-lobby","revision":5,"status":"setup","practice":false,"isCreator":true,"claimedPlayerCount":1,"lobbyCapacity":4,"players":[{"id":"p1","name":"ray","claimed":true}],"exercises":[{"key":"walking","label":"Walking","unitLabel":"mile","category":"movement","trackingType":"quantity","troopsPerUnit":1,"dailyUnitCap":5}],"categoryTroopCaps":{"movement":5},"healthRuleGovernance":"creator","healthRulesVersion":3,"dailyTotalTroopCap":10,"lobbyHealthVoting":{"enabled":true,"voteCounts":{},"submittedPlayerIds":[],"includedExerciseKeys":[],"submissionCount":0,"requiredSubmissions":1,"allSubmitted":false,"hasSubmitted":false,"mySelections":[]}}}"#.utf8
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
