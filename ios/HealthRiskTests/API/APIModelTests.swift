import XCTest
@testable import HealthRisk

final class APIModelTests: XCTestCase {
    func testDecodesAuthenticationAndCurrentSessionResponses() throws {
        let authData = Data(#"{"token":"opaque-token","user":{"id":"u1","username":"ray"}}"#.utf8)
        let auth = try JSONDecoder().decode(AuthResponse.self, from: authData)

        XCTAssertEqual(auth.token, "opaque-token")
        XCTAssertEqual(auth.user, PublicUser(id: "u1", username: "ray"))

        let signedOutData = Data(#"{"user":null,"activeMultiplayerGameId":null}"#.utf8)
        let signedOut = try JSONDecoder().decode(CurrentUserResponse.self, from: signedOutData)
        XCTAssertNil(signedOut.user)
        XCTAssertNil(signedOut.activeMultiplayerGameId)
    }

    func testDecodesGamesResponseFromWireContract() throws {
        let data = Data(
            #"{"games":[{"id":"game-1","status":"active","practice":false,"isCreator":true,"myPlayerIds":["p1"],"playerCount":3,"lobbyCapacity":4,"dayNumber":2,"currentPlayerId":"p1","yourTurn":true,"winnerId":null,"playerNames":["Ray","Ada","Lin"],"inviteLink":"/join/game-1","deepLink":"/game/game-1"}]}"#.utf8
        )

        let response = try JSONDecoder().decode(ListGamesResponse.self, from: data)

        XCTAssertEqual(response.games.count, 1)
        XCTAssertEqual(response.games[0].status, .active)
        XCTAssertTrue(response.games[0].yourTurn)
        XCTAssertEqual(response.games[0].playerNames, ["Ray", "Ada", "Lin"])
        XCTAssertEqual(
            response.games[0].resolvedInviteURL(
                relativeTo: URL(string: "https://health-risk-ecru.vercel.app")!
            )?.absoluteString,
            "https://health-risk-ecru.vercel.app/join/game-1"
        )
    }

    func testDecodesNormalizedServerError() throws {
        let data = Data(
            #"{"error":"idempotency_in_progress","message":"Try this request again.","requestId":"req-42","retryable":true}"#.utf8
        )

        let payload = try JSONDecoder().decode(APIErrorResponse.self, from: data)

        XCTAssertEqual(payload.requestId, "req-42")
        XCTAssertTrue(payload.retryable)
        XCTAssertEqual(payload.error, "idempotency_in_progress")
    }

    func testCreateGameRequestEncodesOnlyRelevantPlayerCount() throws {
        let encoder = JSONEncoder()
        let multiplayer = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: encoder.encode(CreateGameRequest(practice: false)),
                options: []
            ) as? [String: Any]
        )
        let practice = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: encoder.encode(CreateGameRequest(practice: true, players: 10)),
                options: []
            ) as? [String: Any]
        )

        XCTAssertEqual(multiplayer["practice"] as? Bool, false)
        XCTAssertNil(multiplayer["players"])
        XCTAssertEqual(practice["practice"] as? Bool, true)
        XCTAssertEqual(practice["players"] as? Int, 10)
    }

    func testDecodesWaitingRoomHealthRulesContract() throws {
        let game = try JSONDecoder().decode(LobbyGameView.self, from: lobbyGameData)

        XCTAssertEqual(game.id, "game-lobby")
        XCTAssertTrue(game.isCreator)
        XCTAssertEqual(game.players.map(\.name), ["ray"])
        XCTAssertEqual(game.exercises.first?.category, .movement)
        XCTAssertEqual(game.exercises.first?.trackingType, .quantity)
        XCTAssertEqual(game.categoryTroopCaps["movement"], 5)
        XCTAssertEqual(game.dailyTotalTroopCap, 10)
        XCTAssertEqual(game.lobbyHealthVoting.mySelections, ["running"])
        XCTAssertTrue(game.lobbyHealthVoting.hasSubmitted)
    }

    private var lobbyGameData: Data {
        Data(
            #"{"id":"game-lobby","revision":4,"status":"setup","practice":false,"isCreator":true,"claimedPlayerCount":1,"lobbyCapacity":4,"players":[{"id":"p1","name":"ray","claimed":true}],"exercises":[{"key":"running","label":"Running","unitLabel":"mile","category":"movement","trackingType":"quantity","troopsPerUnit":1,"dailyUnitCap":5}],"categoryTroopCaps":{"movement":5},"healthRuleGovernance":"creator","healthRulesVersion":2,"dailyTotalTroopCap":10,"lobbyHealthVoting":{"enabled":true,"voteCounts":{"running":1},"submittedPlayerIds":["p1"],"includedExerciseKeys":["running"],"submissionCount":1,"requiredSubmissions":1,"allSubmitted":true,"hasSubmitted":true,"mySelections":["running"]}}"#.utf8
        )
    }
}
