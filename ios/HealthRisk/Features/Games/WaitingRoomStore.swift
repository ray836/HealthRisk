import Combine
import Foundation

@MainActor
final class WaitingRoomStore: ObservableObject {
    @Published private(set) var game: LobbyGameView?
    @Published private(set) var selectedGoalKeys: Set<String> = []
    @Published private(set) var isLoading = false
    @Published private(set) var isUpdatingRules = false
    @Published private(set) var isSubmittingChoices = false
    @Published var error: APIError?
    @Published var rulesError: APIError?
    @Published var choicesError: APIError?

    let gameId: String
    private let api: any HealthRiskAPI

    init(gameId: String, api: any HealthRiskAPI) {
        self.gameId = gameId
        self.api = api
    }

    var choicesHaveChanges: Bool {
        guard let game else { return false }
        return selectedGoalKeys != Set(game.lobbyHealthVoting.mySelections)
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            apply(try await api.getGame(gameId))
        } catch {
            self.error = APIError.normalized(error)
        }
    }

    func toggleGoal(_ key: String) {
        if selectedGoalKeys.contains(key) {
            selectedGoalKeys.remove(key)
        } else {
            selectedGoalKeys.insert(key)
        }
        choicesError = nil
    }

    func clearRulesError() {
        rulesError = nil
    }

    @discardableResult
    func submitChoices() async -> Bool {
        guard let game, !isSubmittingChoices else { return false }
        isSubmittingChoices = true
        choicesError = nil
        defer { isSubmittingChoices = false }

        let request = LobbyHealthChoicesRequest(
            revision: game.revision,
            exerciseKeys: selectedGoalKeys.sorted()
        )
        do {
            apply(try await api.submitLobbyHealthChoices(gameId: gameId, request: request).game)
            return true
        } catch {
            let normalized = APIError.normalized(error)
            if normalized.code == "stale_game" {
                await load()
            }
            choicesError = normalized
            return false
        }
    }

    @discardableResult
    func updateRules(_ request: HealthRulesUpdateRequest) async -> Bool {
        guard !isUpdatingRules else { return false }
        isUpdatingRules = true
        rulesError = nil
        defer { isUpdatingRules = false }

        do {
            apply(try await api.updateLobbyHealthRules(gameId: gameId, request: request).game)
            return true
        } catch {
            let normalized = APIError.normalized(error)
            if normalized.code == "stale_game" {
                await load()
            }
            rulesError = normalized
            return false
        }
    }

    private func apply(_ game: LobbyGameView) {
        self.game = game
        selectedGoalKeys = Set(game.lobbyHealthVoting.mySelections)
        error = nil
    }
}
