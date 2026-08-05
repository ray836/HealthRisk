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

    struct RecordedGameExit: Equatable, Sendable {
        let gameId: String
        let request: RevisionRequest
    }

    struct RecordedPracticeDeletion: Equatable, Sendable {
        let gameId: String
        let request: RevisionRequest
    }

    struct RecordedGameStart: Equatable, Sendable {
        let gameId: String
        let request: RevisionRequest
    }

    struct RecordedReinforcement: Equatable, Sendable {
        let gameId: String
        let request: ReinforcementRequest
    }

    struct RecordedCardTrade: Equatable, Sendable {
        let gameId: String
        let request: RevisionRequest
    }

    struct RecordedAttack: Equatable, Sendable {
        let gameId: String
        let request: AttackRequest
    }

    struct RecordedFortify: Equatable, Sendable {
        let gameId: String
        let request: FortifyRequest
    }

    struct RecordedEndTurn: Equatable, Sendable {
        let gameId: String
        let request: RevisionRequest
    }

    private var bearerTokens: [String?] = []
    private var currentUserCallCount = 0
    private var createGameRequests: [CreateGameRequest] = []
    private var joinedGameIds: [String] = []
    private var gameStarts: [RecordedGameStart] = []
    private var listGamesCallCount = 0
    private var queuedGamesResults: [Result<ListGamesResponse, APIError>]
    private var gameplayGameCallCount = 0
    private var queuedGameplayGameResults: [Result<GameplayGame, APIError>]
    private var reinforcements: [RecordedReinforcement] = []
    private var cardTrades: [RecordedCardTrade] = []
    private var attacks: [RecordedAttack] = []
    private var fortifications: [RecordedFortify] = []
    private var endedTurns: [RecordedEndTurn] = []
    private var rulesUpdates: [RecordedRulesUpdate] = []
    private var choicesSubmissions: [RecordedChoicesSubmission] = []
    private var gameExits: [RecordedGameExit] = []
    private var practiceDeletions: [RecordedPracticeDeletion] = []

    var metadataResult: Result<APIMetadata, APIError>
    var loginResult: Result<AuthResponse, APIError>
    var signupResult: Result<AuthResponse, APIError>
    var currentUserResult: Result<CurrentUserResponse, APIError>
    var logoutResult: Result<Void, APIError>
    var gamesResult: Result<ListGamesResponse, APIError>
    var createGameResult: Result<GameView, APIError>
    var joinGameResult: Result<JoinGameResponse, APIError>
    var gameResult: Result<LobbyGameView, APIError>
    var startGameResult: Result<GameMutationResponse, APIError>
    var leaveGameResult: Result<LeaveGameResponse, APIError>
    var deletePracticeGameResult: Result<OkResponse, APIError>
    var gameplayGameResult: Result<GameplayGame, APIError>
    var reinforceResult: Result<GameplayMutationResponse, APIError>
    var exerciseLogResult: Result<ExerciseLogMutationResponse, APIError>
    var cardTradeResult: Result<CardTradeMutationResponse, APIError>
    var attackResult: Result<AttackMutationResponse, APIError>
    var fortifyResult: Result<GameplayMutationResponse, APIError>
    var endTurnResult: Result<GameplayMutationResponse, APIError>
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
        gamesResults: [Result<ListGamesResponse, APIError>] = [],
        createGameResult: Result<GameView, APIError> = .failure(unconfiguredAPIError),
        joinGameResult: Result<JoinGameResponse, APIError> = .failure(unconfiguredAPIError),
        gameResult: Result<LobbyGameView, APIError> = .failure(unconfiguredAPIError),
        startGameResult: Result<GameMutationResponse, APIError> = .failure(unconfiguredAPIError),
        leaveGameResult: Result<LeaveGameResponse, APIError> = .failure(unconfiguredAPIError),
        deletePracticeGameResult: Result<OkResponse, APIError> = .failure(unconfiguredAPIError),
        gameplayGameResult: Result<GameplayGame, APIError> = .failure(unconfiguredAPIError),
        gameplayGameResults: [Result<GameplayGame, APIError>] = [],
        reinforceResult: Result<GameplayMutationResponse, APIError> = .failure(unconfiguredAPIError),
        exerciseLogResult: Result<ExerciseLogMutationResponse, APIError> = .failure(unconfiguredAPIError),
        cardTradeResult: Result<CardTradeMutationResponse, APIError> = .failure(unconfiguredAPIError),
        attackResult: Result<AttackMutationResponse, APIError> = .failure(unconfiguredAPIError),
        fortifyResult: Result<GameplayMutationResponse, APIError> = .failure(unconfiguredAPIError),
        endTurnResult: Result<GameplayMutationResponse, APIError> = .failure(unconfiguredAPIError),
        rulesUpdateResult: Result<LobbyGameMutationResponse, APIError> = .failure(unconfiguredAPIError),
        choicesResult: Result<LobbyGameMutationResponse, APIError> = .failure(unconfiguredAPIError)
    ) {
        metadataResult = .failure(unconfiguredAPIError)
        self.loginResult = loginResult
        self.signupResult = signupResult
        self.currentUserResult = currentUserResult
        self.logoutResult = logoutResult
        self.gamesResult = gamesResult
        queuedGamesResults = gamesResults
        self.createGameResult = createGameResult
        self.joinGameResult = joinGameResult
        self.gameResult = gameResult
        self.startGameResult = startGameResult
        self.leaveGameResult = leaveGameResult
        self.deletePracticeGameResult = deletePracticeGameResult
        self.gameplayGameResult = gameplayGameResult
        queuedGameplayGameResults = gameplayGameResults
        self.reinforceResult = reinforceResult
        self.exerciseLogResult = exerciseLogResult
        self.cardTradeResult = cardTradeResult
        self.attackResult = attackResult
        self.fortifyResult = fortifyResult
        self.endTurnResult = endTurnResult
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
    func listGames() async throws -> ListGamesResponse {
        listGamesCallCount += 1
        if !queuedGamesResults.isEmpty {
            return try queuedGamesResults.removeFirst().get()
        }
        return try gamesResult.get()
    }

    func createGame(_ request: CreateGameRequest) async throws -> GameView {
        createGameRequests.append(request)
        return try createGameResult.get()
    }

    func joinGame(gameId: String) async throws -> JoinGameResponse {
        joinedGameIds.append(gameId)
        return try joinGameResult.get()
    }

    func getGame(_ gameId: String) async throws -> LobbyGameView {
        try gameResult.get()
    }

    func startGame(
        gameId: String,
        request: RevisionRequest
    ) async throws -> GameMutationResponse {
        gameStarts.append(RecordedGameStart(gameId: gameId, request: request))
        return try startGameResult.get()
    }

    func leaveGame(
        gameId: String,
        request: RevisionRequest
    ) async throws -> LeaveGameResponse {
        gameExits.append(RecordedGameExit(gameId: gameId, request: request))
        return try leaveGameResult.get()
    }

    func deletePracticeGame(
        gameId: String,
        request: RevisionRequest
    ) async throws -> OkResponse {
        practiceDeletions.append(RecordedPracticeDeletion(gameId: gameId, request: request))
        return try deletePracticeGameResult.get()
    }

    func gameplayGame(_ gameId: String) async throws -> GameplayGame {
        gameplayGameCallCount += 1
        if !queuedGameplayGameResults.isEmpty {
            return try queuedGameplayGameResults.removeFirst().get()
        }
        return try gameplayGameResult.get()
    }

    func reinforce(
        gameId: String,
        request: ReinforcementRequest
    ) async throws -> GameplayMutationResponse {
        reinforcements.append(RecordedReinforcement(gameId: gameId, request: request))
        return try reinforceResult.get()
    }

    func logExercise(
        gameId: String,
        request: ExerciseLogRequest
    ) async throws -> ExerciseLogMutationResponse {
        try exerciseLogResult.get()
    }

    func tradeCards(
        gameId: String,
        request: RevisionRequest
    ) async throws -> CardTradeMutationResponse {
        cardTrades.append(RecordedCardTrade(gameId: gameId, request: request))
        return try cardTradeResult.get()
    }

    func attack(
        gameId: String,
        request: AttackRequest
    ) async throws -> AttackMutationResponse {
        attacks.append(RecordedAttack(gameId: gameId, request: request))
        return try attackResult.get()
    }

    func fortify(
        gameId: String,
        request: FortifyRequest
    ) async throws -> GameplayMutationResponse {
        fortifications.append(RecordedFortify(gameId: gameId, request: request))
        return try fortifyResult.get()
    }

    func endTurn(
        gameId: String,
        request: RevisionRequest
    ) async throws -> GameplayMutationResponse {
        endedTurns.append(RecordedEndTurn(gameId: gameId, request: request))
        return try endTurnResult.get()
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
    func recordedListGamesCallCount() -> Int { listGamesCallCount }
    func recordedCreateGameRequests() -> [CreateGameRequest] { createGameRequests }
    func recordedJoinedGameIds() -> [String] { joinedGameIds }
    func recordedGameStarts() -> [RecordedGameStart] { gameStarts }
    func recordedGameplayGameCallCount() -> Int { gameplayGameCallCount }
    func recordedReinforcements() -> [RecordedReinforcement] { reinforcements }
    func recordedCardTrades() -> [RecordedCardTrade] { cardTrades }
    func recordedAttacks() -> [RecordedAttack] { attacks }
    func recordedFortifications() -> [RecordedFortify] { fortifications }
    func recordedEndedTurns() -> [RecordedEndTurn] { endedTurns }
    func recordedRulesUpdates() -> [RecordedRulesUpdate] { rulesUpdates }
    func recordedChoicesSubmissions() -> [RecordedChoicesSubmission] { choicesSubmissions }
    func recordedGameExits() -> [RecordedGameExit] { gameExits }
    func recordedPracticeDeletions() -> [RecordedPracticeDeletion] { practiceDeletions }

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
