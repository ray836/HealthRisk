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

    func testDecodesConcurrentGamesCapability() throws {
        let data = Data(
            #"{"apiVersion":1,"minimumIosApiVersion":1,"openApiUrl":"/openapi.json","capabilities":{"idempotency":true,"notifications":true,"apnsConfigured":false,"universalInvites":true,"chatSafety":true,"multipleConcurrentGames":true}}"#.utf8
        )

        let metadata = try JSONDecoder().decode(APIMetadata.self, from: data)

        XCTAssertEqual(metadata.capabilities.multipleConcurrentGames, true)
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

    func testLobbyHealthChoicesEncodeBothConcurrencyVersions() throws {
        let request = LobbyHealthChoicesRequest(
            revision: 12,
            healthRulesVersion: 3,
            exerciseKeys: ["running"]
        )

        let payload = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        )

        XCTAssertEqual(payload["revision"] as? Int, 12)
        XCTAssertEqual(payload["healthRulesVersion"] as? Int, 3)
        XCTAssertEqual(payload["exerciseKeys"] as? [String], ["running"])
    }

    func testDecodesAuthoritativeGameplayContract() throws {
        let game = try JSONDecoder().decode(GameplayGame.self, from: gameplayGameData)

        XCTAssertEqual(game.id, "game-play")
        XCTAssertEqual(game.revision, 7)
        XCTAssertEqual(game.phase, .reinforce)
        XCTAssertTrue(game.yourTurn)
        XCTAssertEqual(game.currentPlayer?.name, "Ray")
        XCTAssertEqual(game.currentPlayerReinforcements, 5)
        XCTAssertEqual(game.continents.first?.label, "North America")
        XCTAssertEqual(game.territories.first?.owner, "p1")
        XCTAssertEqual(game.territories.first?.neighbors, ["northwest_territory"])
        XCTAssertEqual(game.dashboard?.cards.hand.first?.territoryId, "alaska")
        XCTAssertEqual(game.dashboard?.cards.tradeReward, 3)
        XCTAssertTrue(game.dashboard?.cards.canTrade == true)
        XCTAssertEqual(game.dashboard?.turnSummary?.attacksMade, 2)
        XCTAssertTrue(game.dashboard?.turnSummary?.cardPending == true)
    }

    func testDecodesPrivacySafeSharedHealthMomentum() throws {
        let data = Data(
            #"{"playerId":"p1","troopsEarned":4,"dailyCap":6,"percent":67,"goalsCompleted":1,"goalsTracked":2,"status":"in_progress","historyWindowDays":3,"consistencyPercent":50,"goals":[{"exerciseKey":"running","currentStatus":"in_progress","completedDays":2,"trackedDays":3,"consistencyPercent":67}]}"#.utf8
        )

        let progress = try JSONDecoder().decode(GameplaySharedHealthProgress.self, from: data)

        XCTAssertEqual(progress.historyWindowDays, 3)
        XCTAssertEqual(progress.consistencyPercent, 50)
        XCTAssertEqual(progress.goals?.first?.exerciseKey, "running")
        XCTAssertEqual(progress.goals?.first?.currentStatus, .inProgress)
        XCTAssertEqual(progress.goals?.first?.completedDays, 2)
    }

    func testDecodesAuthoritativeMultiRoundAttackResult() throws {
        let data = Data(
            ##"{"result":{"fromId":"alaska","toId":"northwest_territory","endReason":"capture","captured":true,"rounds":[{"attackerDice":[6,5,2],"defenderDice":[5,4],"attackerLosses":0,"defenderLosses":2,"attackerForceAfter":5,"defenderForceAfter":1},{"attackerDice":[4,3,1],"defenderDice":[2],"attackerLosses":0,"defenderLosses":1,"attackerForceAfter":5,"defenderForceAfter":0}],"totalAttackerLosses":0,"totalDefenderLosses":3,"survivingAttackers":5,"remainingDefenders":0,"seed":42},"game":{"id":"game-play","revision":7,"practice":false,"status":"active","winnerId":null,"dayNumber":0,"turnOrder":["p1","p2"],"currentPlayerId":"p1","mySeats":["p1"],"isCreator":true,"yourTurn":true,"phase":"attack","windowExpiresAt":"2026-08-03T02:00:00.000Z","nextSessionOpensAt":null,"schedule":{"timezone":"America/Denver","dailyStartMinuteOfDay":1140,"playerWindowMinutes":720,"moveDeadlineAt":"2026-08-03T02:00:00.000Z","nextSessionOpensAt":null,"missedTurnPolicy":"auto_resolve"},"players":[{"id":"p1","name":"Ray","status":"active","color":"#6ea8fe","pendingReinforcements":0,"pendingEliminationReward":0,"note":"","claimed":true},{"id":"p2","name":"Tess","status":"active","color":"#69d39b","pendingReinforcements":0,"pendingEliminationReward":0,"note":"","claimed":true}],"continents":[{"id":"north_america","label":"North America","bonus":5}],"territories":[{"id":"alaska","owner":"p1","armies":1,"continent":"north_america","neighbors":["northwest_territory"],"color":"#6ea8fe"},{"id":"northwest_territory","owner":"p1","armies":5,"continent":"north_america","neighbors":["alaska"],"color":"#6ea8fe"}]}}"##.utf8
        )

        let response = try JSONDecoder().decode(AttackMutationResponse.self, from: data)

        XCTAssertTrue(response.result.captured)
        XCTAssertEqual(response.result.endReason, .capture)
        XCTAssertEqual(response.result.rounds.count, 2)
        XCTAssertEqual(response.result.totalDefenderLosses, 3)
        XCTAssertEqual(response.result.survivingAttackers, 5)
        XCTAssertEqual(response.game.territories.last?.owner, "p1")
    }

    private var lobbyGameData: Data {
        Data(
            #"{"id":"game-lobby","revision":4,"status":"setup","practice":false,"isCreator":true,"claimedPlayerCount":1,"lobbyCapacity":4,"players":[{"id":"p1","name":"ray","claimed":true}],"exercises":[{"key":"running","label":"Running","unitLabel":"mile","category":"movement","trackingType":"quantity","troopsPerUnit":1,"dailyUnitCap":5}],"categoryTroopCaps":{"movement":5},"healthRuleGovernance":"creator","healthRulesVersion":2,"dailyTotalTroopCap":10,"lobbyHealthVoting":{"enabled":true,"voteCounts":{"running":1},"submittedPlayerIds":["p1"],"includedExerciseKeys":["running"],"submissionCount":1,"requiredSubmissions":1,"allSubmitted":true,"hasSubmitted":true,"mySelections":["running"]}}"#.utf8
        )
    }

    private var gameplayGameData: Data {
        Data(
            ##"{"id":"game-play","revision":7,"practice":false,"status":"active","winnerId":null,"dayNumber":0,"turnOrder":["p1","p2"],"currentPlayerId":"p1","mySeats":["p1"],"isCreator":true,"yourTurn":true,"phase":"reinforce","windowExpiresAt":"2026-08-03T02:00:00.000Z","nextSessionOpensAt":null,"schedule":{"timezone":"America/Denver","dailyStartMinuteOfDay":1140,"playerWindowMinutes":720,"moveDeadlineAt":"2026-08-03T02:00:00.000Z","nextSessionOpensAt":null,"missedTurnPolicy":"auto_resolve"},"players":[{"id":"p1","name":"Ray","status":"active","color":"#6ea8fe","pendingReinforcements":5,"pendingEliminationReward":0,"note":"","claimed":true},{"id":"p2","name":"Tess","status":"active","color":"#69d39b","pendingReinforcements":0,"pendingEliminationReward":0,"note":"","claimed":true}],"continents":[{"id":"north_america","label":"North America","bonus":5}],"territories":[{"id":"alaska","owner":"p1","armies":4,"continent":"north_america","neighbors":["northwest_territory"],"color":"#6ea8fe"},{"id":"northwest_territory","owner":"p2","armies":2,"continent":"north_america","neighbors":["alaska"],"color":"#69d39b"}],"dashboard":{"playerId":"p1","cards":{"hand":[{"id":"card-1","territoryId":"alaska","earnedDay":0},{"id":"card-2","territoryId":"alberta","earnedDay":0},{"id":"card-3","territoryId":"ontario","earnedDay":0}],"tradeSize":3,"tradeReward":3,"canTrade":true},"turnSummary":{"reinforcementsPlaced":5,"placementsMade":2,"attacksMade":2,"attackerLosses":1,"defenderLosses":3,"territoriesCaptured":["alberta"],"cardsTraded":0,"cardPending":true,"fortification":null}}}"##.utf8
        )
    }
}
