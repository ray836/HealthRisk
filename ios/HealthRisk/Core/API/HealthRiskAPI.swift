import Foundation

protocol HealthRiskAPI: Sendable {
    func setBearerToken(_ token: String?) async
    func metadata() async throws -> APIMetadata
    func login(_ request: AuthRequest) async throws -> AuthResponse
    func signup(_ request: AuthRequest) async throws -> AuthResponse
    func currentUser() async throws -> CurrentUserResponse
    func logout() async throws
    func listGames() async throws -> ListGamesResponse
    func createGame(_ request: CreateGameRequest) async throws -> GameView
    func getGame(_ gameId: String) async throws -> LobbyGameView
    func leaveGame(gameId: String, request: RevisionRequest) async throws -> LeaveGameResponse
    func updateLobbyHealthRules(
        gameId: String,
        request: HealthRulesUpdateRequest
    ) async throws -> LobbyGameMutationResponse
    func submitLobbyHealthChoices(
        gameId: String,
        request: LobbyHealthChoicesRequest
    ) async throws -> LobbyGameMutationResponse
}

protocol URLSessioning: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: URLSessioning {
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await data(for: request, delegate: nil)
    }
}
