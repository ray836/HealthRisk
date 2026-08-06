import Combine
import Foundation

protocol GameplaySyncSleeping: Sendable {
    func sleep() async throws
}

struct GameplaySyncSleeper: GameplaySyncSleeping {
    let interval: Duration

    init(interval: Duration = .seconds(5)) {
        self.interval = interval
    }

    func sleep() async throws {
        try await Task.sleep(for: interval)
    }
}

struct GameCompletionPresentation: Equatable {
    struct Standing: Identifiable, Equatable {
        let id: String
        let name: String
        let territories: Int
        let status: GamePlayerStatus
    }

    let winnerId: String
    let winnerName: String
    let didWin: Bool
    let standings: [Standing]

    init?(game: GameplayGame) {
        guard game.status == .finished,
              let winnerId = game.winnerId,
              let winner = game.players.first(where: { $0.id == winnerId }) else {
            return nil
        }
        self.winnerId = winnerId
        winnerName = winner.name
        didWin = game.mySeats.contains(winnerId)
        standings = game.players
            .map { player in
                Standing(
                    id: player.id,
                    name: player.name,
                    territories: game.territories.filter { $0.owner == player.id }.count,
                    status: player.status
                )
            }
            .sorted { left, right in
                if left.id == winnerId { return true }
                if right.id == winnerId { return false }
                if left.territories != right.territories {
                    return left.territories > right.territories
                }
                return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
            }
    }
}

@MainActor
final class GameplayStore: ObservableObject {
    @Published private(set) var game: GameplayGame?
    @Published private(set) var isLoading = false
    @Published private(set) var isRefreshing = false
    @Published private(set) var isPerformingAction = false
    @Published private(set) var lastAttackResult: AttackResult?
    @Published private(set) var lastAwardedCard: TerritoryCard?
    @Published var error: APIError?
    @Published var actionError: APIError?

    let gameId: String
    private let api: any HealthRiskAPI
    private let syncSleeper: any GameplaySyncSleeping

    init(
        gameId: String,
        api: any HealthRiskAPI,
        syncSleeper: any GameplaySyncSleeping = GameplaySyncSleeper()
    ) {
        self.gameId = gameId
        self.api = api
        self.syncSleeper = syncSleeper
    }

    func load() async {
        await refresh(showsInitialLoading: game == nil)
    }

    /// Refresh while the campaign is visible. The view-owned task cancels this
    /// loop automatically on navigation or when the app leaves the foreground.
    func synchronize() async {
        await refresh(showsInitialLoading: game == nil)
        while !Task.isCancelled {
            if let status = game?.status, status != .active { return }
            do {
                try await syncSleeper.sleep()
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            await refresh(showsInitialLoading: false)
        }
    }

    private func refresh(showsInitialLoading: Bool) async {
        guard !isLoading, !isRefreshing, !isPerformingAction else { return }
        if showsInitialLoading {
            isLoading = true
        } else {
            isRefreshing = true
        }
        defer {
            isLoading = false
            isRefreshing = false
        }

        do {
            applyAuthoritativeGame(try await api.gameplayGame(gameId))
            error = nil
        } catch {
            self.error = APIError.normalized(error)
        }
    }

    func clearActionError() {
        actionError = nil
    }

    func clearAttackResult() {
        lastAttackResult = nil
    }

    func clearAwardedCard() {
        lastAwardedCard = nil
    }

    @discardableResult
    func reinforce(territoryId: String, count: Int) async -> Bool {
        guard let game else { return false }
        let request = ReinforcementRequest(
            revision: game.revision,
            placements: [ReinforcementPlacement(territoryId: territoryId, count: count)]
        )
        return await mutate { try await api.reinforce(gameId: gameId, request: request) }
    }

    @discardableResult
    func logExercise(exerciseKey: String, units: Double) async -> Bool {
        guard let game else { return false }
        let request = ExerciseLogRequest(
            revision: game.revision,
            exerciseKey: exerciseKey,
            units: units
        )
        guard !isPerformingAction else { return false }
        isPerformingAction = true
        actionError = nil
        defer { isPerformingAction = false }

        do {
            let response = try await api.logExercise(gameId: gameId, request: request)
            applyAuthoritativeGame(response.game)
            error = nil
            return true
        } catch {
            return await handleMutationError(error)
        }
    }

    @discardableResult
    func tradeCards() async -> Bool {
        guard let game else { return false }
        let request = RevisionRequest(revision: game.revision)
        guard !isPerformingAction else { return false }
        isPerformingAction = true
        actionError = nil
        defer { isPerformingAction = false }

        do {
            let response = try await api.tradeCards(gameId: gameId, request: request)
            applyAuthoritativeGame(response.game)
            error = nil
            return true
        } catch {
            return await handleMutationError(error)
        }
    }

    @discardableResult
    func attack(
        fromId: String,
        toId: String,
        committedTroops: Int,
        stopLoss: Int
    ) async -> Bool {
        guard let game else { return false }
        let request = AttackRequest(
            revision: game.revision,
            fromId: fromId,
            toId: toId,
            committedTroops: committedTroops,
            stopLoss: stopLoss
        )
        guard !isPerformingAction else { return false }
        isPerformingAction = true
        actionError = nil
        lastAttackResult = nil
        defer { isPerformingAction = false }

        do {
            let response = try await api.attack(gameId: gameId, request: request)
            applyAuthoritativeGame(response.game)
            lastAttackResult = response.result
            error = nil
            return true
        } catch {
            return await handleMutationError(error)
        }
    }

    @discardableResult
    func fortify(fromId: String, toId: String, count: Int) async -> Bool {
        guard let game else { return false }
        let request = FortifyRequest(
            revision: game.revision,
            fromId: fromId,
            toId: toId,
            count: count
        )
        return await mutate { try await api.fortify(gameId: gameId, request: request) }
    }

    @discardableResult
    func endTurn() async -> Bool {
        guard let game else { return false }
        let request = RevisionRequest(revision: game.revision)
        guard !isPerformingAction else { return false }
        isPerformingAction = true
        actionError = nil
        lastAwardedCard = nil
        defer { isPerformingAction = false }

        do {
            let response = try await api.endTurn(gameId: gameId, request: request)
            applyAuthoritativeGame(response.game)
            lastAwardedCard = response.cardAwarded
            error = nil
            return true
        } catch {
            return await handleMutationError(error)
        }
    }

    @discardableResult
    func deletePracticeGame() async -> Bool {
        guard let game, game.practice, !isPerformingAction else { return false }
        isPerformingAction = true
        actionError = nil
        defer { isPerformingAction = false }

        do {
            let response = try await api.deletePracticeGame(
                gameId: gameId,
                request: RevisionRequest(revision: game.revision)
            )
            guard response.ok else {
                actionError = APIError(
                    statusCode: nil,
                    code: "delete_failed",
                    message: "The practice game could not be deleted.",
                    requestId: nil,
                    retryable: false
                )
                return false
            }
            self.game = nil
            error = nil
            return true
        } catch {
            return await handleMutationError(error)
        }
    }

    @discardableResult
    func forfeitGame() async -> Bool {
        let controlsEligibleSeat = game?.players.contains { player in
            guard game?.mySeats.contains(player.id) == true else { return false }
            switch player.status {
            case .active, .autoPiloted:
                return true
            case .forfeited, .eliminated:
                return false
            }
        } ?? false
        guard let game,
              !game.practice,
              game.status == .active,
              controlsEligibleSeat,
              !isPerformingAction else { return false }
        isPerformingAction = true
        actionError = nil
        defer { isPerformingAction = false }

        do {
            let response = try await api.leaveGame(
                gameId: gameId,
                request: RevisionRequest(revision: game.revision)
            )
            guard response.ok else {
                actionError = APIError(
                    statusCode: nil,
                    code: "forfeit_failed",
                    message: "The game could not be forfeited.",
                    requestId: nil,
                    retryable: false
                )
                return false
            }
            self.game = nil
            error = nil
            return true
        } catch {
            return await handleMutationError(error)
        }
    }

    private func mutate(
        _ action: () async throws -> GameplayMutationResponse
    ) async -> Bool {
        guard !isPerformingAction else { return false }
        isPerformingAction = true
        actionError = nil
        defer { isPerformingAction = false }

        do {
            let response = try await action()
            applyAuthoritativeGame(response.game)
            error = nil
            return true
        } catch {
            return await handleMutationError(error)
        }
    }

    private func applyAuthoritativeGame(_ updated: GameplayGame) {
        guard game == nil || updated.revision >= game!.revision else { return }
        game = updated
    }

    private func handleMutationError(_ error: Error) async -> Bool {
        let normalized = APIError.normalized(error)
        if normalized.code == "stale_game" {
            await load()
        }
        actionError = normalized
        return false
    }
}
