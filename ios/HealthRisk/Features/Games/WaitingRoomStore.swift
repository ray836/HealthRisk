import Combine
import Foundation

protocol WaitingRoomSyncSleeping: Sendable {
    func sleep() async throws
}

struct WaitingRoomSyncSleeper: WaitingRoomSyncSleeping {
    let interval: Duration

    init(interval: Duration = .seconds(5)) {
        self.interval = interval
    }

    func sleep() async throws {
        try await Task.sleep(for: interval)
    }
}

@MainActor
final class WaitingRoomStore: ObservableObject {
    @Published private(set) var game: LobbyGameView?
    @Published private(set) var selectedGoalKeys: Set<String> = []
    @Published private(set) var isLoading = false
    @Published private(set) var isUpdatingRules = false
    @Published private(set) var isSubmittingChoices = false
    @Published private(set) var isStartingGame = false
    @Published private(set) var isExitingLobby = false
    @Published var error: APIError?
    @Published var rulesError: APIError?
    @Published var choicesError: APIError?
    @Published var startError: APIError?
    @Published var exitError: APIError?

    let gameId: String
    private let api: any HealthRiskAPI
    private let syncSleeper: any WaitingRoomSyncSleeping

    init(
        gameId: String,
        api: any HealthRiskAPI,
        syncSleeper: any WaitingRoomSyncSleeping = WaitingRoomSyncSleeper()
    ) {
        self.gameId = gameId
        self.api = api
        self.syncSleeper = syncSleeper
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

    /// Keep the lobby current until it starts. The view-owned task cancels
    /// this loop automatically when the waiting room leaves the foreground.
    func synchronize() async {
        await load()
        while !Task.isCancelled {
            if let status = game?.status, status != .setup { return }
            if error?.isUnauthorized == true { return }
            do {
                try await syncSleeper.sleep()
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            await load()
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
    func startGame() async -> Bool {
        guard let game, !isStartingGame, !isExitingLobby else { return false }
        isStartingGame = true
        startError = nil
        defer { isStartingGame = false }

        do {
            let response = try await api.startGame(
                gameId: gameId,
                request: RevisionRequest(revision: game.revision)
            )
            guard response.game.status == .active else {
                startError = APIError(
                    statusCode: nil,
                    code: "start_failed",
                    message: "The game did not start.",
                    requestId: nil,
                    retryable: false
                )
                return false
            }
            self.game = nil
            selectedGoalKeys = []
            return true
        } catch {
            let normalized = APIError.normalized(error)
            if normalized.code == "stale_game" {
                await load()
            }
            startError = normalized
            return false
        }
    }

    @discardableResult
    func exitLobby() async -> Bool {
        guard let game, !isExitingLobby, !isStartingGame else { return false }
        isExitingLobby = true
        exitError = nil
        defer { isExitingLobby = false }

        do {
            let response = try await api.leaveGame(
                gameId: gameId,
                request: RevisionRequest(revision: game.revision)
            )
            guard response.ok else {
                exitError = APIError(
                    statusCode: nil,
                    code: "leave_failed",
                    message: "The game could not be left.",
                    requestId: nil,
                    retryable: false
                )
                return false
            }
            self.game = nil
            selectedGoalKeys = []
            return true
        } catch {
            let normalized = APIError.normalized(error)
            if normalized.code == "stale_game" {
                await load()
            }
            exitError = normalized
            return false
        }
    }

    @discardableResult
    func submitChoices() async -> Bool {
        guard let game, !isSubmittingChoices else { return false }
        isSubmittingChoices = true
        choicesError = nil
        defer { isSubmittingChoices = false }

        let request = LobbyHealthChoicesRequest(
            revision: game.revision,
            healthRulesVersion: game.healthRulesVersion,
            exerciseKeys: selectedGoalKeys.sorted()
        )
        do {
            apply(try await api.submitLobbyHealthChoices(gameId: gameId, request: request).game)
            return true
        } catch {
            let normalized = APIError.normalized(error)
            if normalized.code == "stale_health_rules" {
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
        let shouldPreserveDraft = self.game.map {
            selectedGoalKeys != Set($0.lobbyHealthVoting.mySelections) &&
                $0.healthRulesVersion == game.healthRulesVersion
        } ?? false
        self.game = game
        if !shouldPreserveDraft {
            selectedGoalKeys = Set(game.lobbyHealthVoting.mySelections)
        }
        error = nil
        startError = nil
        exitError = nil
    }
}
