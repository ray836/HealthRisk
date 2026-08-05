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
    func joinGame(gameId: String) async throws -> JoinGameResponse
    func getGame(_ gameId: String) async throws -> LobbyGameView
    func startGame(gameId: String, request: RevisionRequest) async throws -> GameMutationResponse
    func leaveGame(gameId: String, request: RevisionRequest) async throws -> LeaveGameResponse
    func deletePracticeGame(gameId: String, request: RevisionRequest) async throws -> OkResponse
    func gameplayGame(_ gameId: String) async throws -> GameplayGame
    func reinforce(gameId: String, request: ReinforcementRequest) async throws -> GameplayMutationResponse
    func logExercise(gameId: String, request: ExerciseLogRequest) async throws -> ExerciseLogMutationResponse
    func tradeCards(gameId: String, request: RevisionRequest) async throws -> CardTradeMutationResponse
    func attack(gameId: String, request: AttackRequest) async throws -> AttackMutationResponse
    func fortify(gameId: String, request: FortifyRequest) async throws -> GameplayMutationResponse
    func endTurn(gameId: String, request: RevisionRequest) async throws -> GameplayMutationResponse
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
