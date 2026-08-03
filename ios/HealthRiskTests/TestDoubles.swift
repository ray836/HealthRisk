import Foundation
@testable import HealthRisk

private let unconfiguredAPIError = APIError(
    statusCode: nil,
    code: "unconfigured_test_double",
    message: "Test double not configured",
    requestId: nil,
    retryable: false
)

actor MockHealthRiskAPI: HealthRiskAPI {
    struct RecordedRulesUpdate: Equatable, Sendable {
        let gameId: String
        let request: HealthRulesUpdateRequest
    }

    struct RecordedChoicesSubmission: Equatable, Sendable {
        let gameId: String
        let request: LobbyHealthChoicesRequest
    }

    private var bearerTokens: [String?] = []
    private var currentUserCallCount = 0
    private var createGameRequests: [CreateGameRequest] = []
    private var rulesUpdates: [RecordedRulesUpdate] = []
    private var choicesSubmissions: [RecordedChoicesSubmission] = []

    var metadataResult: Result<APIMetadata, APIError>
    var loginResult: Result<AuthResponse, APIError>
    var signupResult: Result<AuthResponse, APIError>
    var currentUserResult: Result<CurrentUserResponse, APIError>
    var logoutResult: Result<Void, APIError>
    var gamesResult: Result<ListGamesResponse, APIError>
    var createGameResult: Result<GameView, APIError>
    var gameResult: Result<LobbyGameView, APIError>
    var rulesUpdateResult: Result<LobbyGameMutationResponse, APIError>
    var choicesResult: Result<LobbyGameMutationResponse, APIError>

    init(
        loginResult: Result<AuthResponse, APIError> = .failure(unconfiguredAPIError),
        signupResult: Result<AuthResponse, APIError> = .failure(unconfiguredAPIError),
        currentUserResult: Result<CurrentUserResponse, APIError> = .success(
            CurrentUserResponse(user: nil, activeMultiplayerGameId: nil)
        ),
        logoutResult: Result<Void, APIError> = .success(()),
        gamesResult: Result<ListGamesResponse, APIError> = .success(ListGamesResponse(games: [])),
        createGameResult: Result<GameView, APIError> = .failure(unconfiguredAPIError),
        gameResult: Result<LobbyGameView, APIError> = .failure(unconfiguredAPIError),
        rulesUpdateResult: Result<LobbyGameMutationResponse, APIError> = .failure(unconfiguredAPIError),
        choicesResult: Result<LobbyGameMutationResponse, APIError> = .failure(unconfiguredAPIError)
    ) {
        metadataResult = .failure(unconfiguredAPIError)
        self.loginResult = loginResult
        self.signupResult = signupResult
        self.currentUserResult = currentUserResult
        self.logoutResult = logoutResult
        self.gamesResult = gamesResult
        self.createGameResult = createGameResult
        self.gameResult = gameResult
        self.rulesUpdateResult = rulesUpdateResult
        self.choicesResult = choicesResult
    }

    func setBearerToken(_ token: String?) {
        bearerTokens.append(token)
    }

    func metadata() async throws -> APIMetadata { try metadataResult.get() }
    func login(_ request: AuthRequest) async throws -> AuthResponse { try loginResult.get() }
    func signup(_ request: AuthRequest) async throws -> AuthResponse { try signupResult.get() }

    func currentUser() async throws -> CurrentUserResponse {
        currentUserCallCount += 1
        return try currentUserResult.get()
    }

    func logout() async throws { try logoutResult.get() }
    func listGames() async throws -> ListGamesResponse { try gamesResult.get() }

    func createGame(_ request: CreateGameRequest) async throws -> GameView {
        createGameRequests.append(request)
        return try createGameResult.get()
    }

    func getGame(_ gameId: String) async throws -> LobbyGameView {
        try gameResult.get()
    }

    func updateLobbyHealthRules(
        gameId: String,
        request: HealthRulesUpdateRequest
    ) async throws -> LobbyGameMutationResponse {
        rulesUpdates.append(RecordedRulesUpdate(gameId: gameId, request: request))
        return try rulesUpdateResult.get()
    }

    func submitLobbyHealthChoices(
        gameId: String,
        request: LobbyHealthChoicesRequest
    ) async throws -> LobbyGameMutationResponse {
        choicesSubmissions.append(RecordedChoicesSubmission(gameId: gameId, request: request))
        return try choicesResult.get()
    }

    func recordedBearerTokens() -> [String?] { bearerTokens }
    func recordedCurrentUserCallCount() -> Int { currentUserCallCount }
    func recordedCreateGameRequests() -> [CreateGameRequest] { createGameRequests }
    func recordedRulesUpdates() -> [RecordedRulesUpdate] { rulesUpdates }
    func recordedChoicesSubmissions() -> [RecordedChoicesSubmission] { choicesSubmissions }

}

final class MemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var token: String?
    private(set) var saveCount = 0
    private(set) var deleteCount = 0

    init(token: String? = nil) {
        self.token = token
    }

    func readToken() throws -> String? {
        lock.withLock { token }
    }

    func saveToken(_ token: String) throws {
        lock.withLock {
            self.token = token
            saveCount += 1
        }
    }

    func deleteToken() throws {
        lock.withLock {
            token = nil
            deleteCount += 1
        }
    }
}
