import Combine
import Foundation

protocol GamesSyncSleeping: Sendable {
    func sleep() async throws
}

struct GamesSyncSleeper: GamesSyncSleeping {
    let interval: Duration

    init(interval: Duration = .seconds(5)) {
        self.interval = interval
    }

    func sleep() async throws {
        try await Task.sleep(for: interval)
    }
}

@MainActor
final class GamesStore: ObservableObject {
    @Published private(set) var games: [GameSummary] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isCreating = false
    @Published private(set) var isJoining = false
    @Published var error: APIError?
    @Published var createError: APIError?
    @Published var joinError: APIError?

    private let api: any HealthRiskAPI
    private let syncSleeper: any GamesSyncSleeping

    init(
        api: any HealthRiskAPI,
        syncSleeper: any GamesSyncSleeping = GamesSyncSleeper()
    ) {
        self.api = api
        self.syncSleeper = syncSleeper
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        error = nil

        do {
            games = try await api.listGames().games
        } catch {
            self.error = APIError.normalized(error)
        }

        isLoading = false
    }

    /// Keep turn badges current while the game library is visible. The
    /// view-owned task cancels this loop when the app leaves the foreground.
    func synchronize() async {
        await load()
        if error?.isUnauthorized == true { return }
        while !Task.isCancelled {
            do {
                try await syncSleeper.sleep()
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            await load()
            if error?.isUnauthorized == true { return }
        }
    }

    func games(with statuses: Set<GameStatus>) -> [GameSummary] {
        games.filter { statuses.contains($0.status) }
    }

    func clearCreateError() {
        createError = nil
    }

    func clearJoinError() {
        joinError = nil
    }

    @discardableResult
    func createGame(_ request: CreateGameRequest) async -> Bool {
        guard !isCreating else { return false }
        isCreating = true
        createError = nil
        defer { isCreating = false }

        do {
            _ = try await api.createGame(request)
        } catch {
            createError = APIError.normalized(error)
            return false
        }

        // Creation already succeeded. A refresh failure must not encourage a
        // second logical mutation that could create a duplicate game.
        do {
            games = try await api.listGames().games
            error = nil
        } catch {
            self.error = APIError.normalized(error)
        }
        return true
    }

    @discardableResult
    func joinGame(gameId: String) async -> Bool {
        guard !isJoining else { return false }
        isJoining = true
        joinError = nil
        defer { isJoining = false }

        do {
            _ = try await api.joinGame(gameId: gameId)
        } catch {
            joinError = APIError.normalized(error)
            return false
        }

        // Joining already succeeded. Keep that success even if refreshing the
        // library fails, so the UI never encourages a second logical mutation.
        do {
            games = try await api.listGames().games
            error = nil
        } catch {
            self.error = APIError.normalized(error)
        }
        return true
    }
}
