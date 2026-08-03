import Combine
import Foundation

@MainActor
final class GamesStore: ObservableObject {
    @Published private(set) var games: [GameSummary] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isCreating = false
    @Published var error: APIError?
    @Published var createError: APIError?

    private let api: any HealthRiskAPI

    init(api: any HealthRiskAPI) {
        self.api = api
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

    func games(with statuses: Set<GameStatus>) -> [GameSummary] {
        games.filter { statuses.contains($0.status) }
    }

    func clearCreateError() {
        createError = nil
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
}
