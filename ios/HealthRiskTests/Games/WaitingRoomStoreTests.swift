import XCTest
@testable import HealthRisk

@MainActor
final class WaitingRoomStoreTests: XCTestCase {
    func testLoadsGoalsAndSubmitsSelectedChoicesWithLatestRevision() async {
        let initial = lobbyGame(revision: 4)
        let submitted = lobbyGame(revision: 5, selections: ["running"], hasSubmitted: true)
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
                    request: LobbyHealthChoicesRequest(revision: 4, exerciseKeys: ["running"])
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

    private func lobbyGame(
        revision: Int,
        goalLabel: String = "Running",
        selections: [String] = [],
        hasSubmitted: Bool = false
    ) -> LobbyGameView {
        let key = goalLabel.lowercased()
        return LobbyGameView(
            id: "game-lobby",
            revision: revision,
            status: .setup,
            practice: false,
            isCreator: true,
            claimedPlayerCount: 1,
            lobbyCapacity: 4,
            players: [LobbyPlayer(id: "p1", name: "ray", claimed: true)],
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
            healthRulesVersion: revision,
            dailyTotalTroopCap: 10,
            lobbyHealthVoting: LobbyHealthVoting(
                enabled: true,
                voteCounts: selections.isEmpty ? [:] : [key: 1],
                submittedPlayerIds: hasSubmitted ? ["p1"] : [],
                includedExerciseKeys: selections,
                submissionCount: hasSubmitted ? 1 : 0,
                requiredSubmissions: 1,
                allSubmitted: hasSubmitted,
                hasSubmitted: hasSubmitted,
                mySelections: selections
            )
        )
    }
}
