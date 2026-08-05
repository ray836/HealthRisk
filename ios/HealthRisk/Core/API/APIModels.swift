import Foundation

// These wire types mirror public/openapi.json and the more specific response
// shapes in src/client/apiTypes.ts. Keep view-only state out of this file.

struct APIErrorResponse: Codable, Equatable, Sendable {
    let error: String
    let message: String
    let requestId: String
    let retryable: Bool
}

struct AuthRequest: Codable, Equatable, Sendable {
    let username: String
    let password: String
}

struct PublicUser: Codable, Equatable, Sendable {
    let id: String
    let username: String
}

struct AuthResponse: Codable, Equatable, Sendable {
    let token: String
    let user: PublicUser
}

struct CurrentUserResponse: Codable, Equatable, Sendable {
    let user: PublicUser?
    let activeMultiplayerGameId: String?
}

struct APIMetadata: Codable, Equatable, Sendable {
    struct Capabilities: Codable, Equatable, Sendable {
        let idempotency: Bool
        let notifications: Bool
        let apnsConfigured: Bool
        let universalInvites: Bool
        let chatSafety: Bool
        let multipleConcurrentGames: Bool?
    }

    let apiVersion: Int
    let minimumIosApiVersion: Int
    let openApiUrl: String
    let capabilities: Capabilities
}

enum GameStatus: String, Codable, CaseIterable, Sendable {
    case setup
    case active
    case finished
    case cancelled
}

struct GameSummary: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let status: GameStatus
    let practice: Bool
    let isCreator: Bool
    let myPlayerIds: [String]
    let playerCount: Int
    let lobbyCapacity: Int
    let dayNumber: Int
    let currentPlayerId: String?
    let yourTurn: Bool
    let winnerId: String?
    let playerNames: [String]
    let inviteLink: String?
    let deepLink: String
}

extension GameSummary {
    func resolvedInviteURL(relativeTo baseURL: URL) -> URL? {
        guard let inviteLink,
              let parsedURL = URL(string: inviteLink) else {
            return nil
        }
        if parsedURL.scheme != nil {
            return parsedURL
        }
        return URL(string: inviteLink, relativeTo: baseURL)?.absoluteURL
    }
}

struct ListGamesResponse: Codable, Equatable, Sendable {
    let games: [GameSummary]
}

struct CreateGameRequest: Codable, Equatable, Sendable {
    let practice: Bool
    let players: Int?

    init(practice: Bool, players: Int? = nil) {
        self.practice = practice
        self.players = players
    }
}

struct JoinGameResponse: Codable, Equatable, Sendable {
    let seat: String
    let game: GameView
}

enum HealthCategory: String, Codable, CaseIterable, Identifiable, Sendable {
    case movement
    case nutrition
    case recovery

    var id: String { rawValue }
}

enum HealthTrackingType: String, Codable, CaseIterable, Identifiable, Sendable {
    case quantity
    case duration
    case checkbox

    var id: String { rawValue }
}

enum HealthRuleGovernance: String, Codable, Sendable {
    case creator
    case vote
}

struct HealthGoalRule: Codable, Identifiable, Equatable, Sendable {
    let key: String
    let label: String
    let unitLabel: String
    let category: HealthCategory
    let trackingType: HealthTrackingType
    let troopsPerUnit: Double
    let dailyUnitCap: Double?

    var id: String { key }
}

struct LobbyPlayer: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let claimed: Bool
}

struct LobbyHealthVoting: Codable, Equatable, Sendable {
    let enabled: Bool
    let voteCounts: [String: Int]
    let submittedPlayerIds: [String]
    let includedExerciseKeys: [String]
    let submissionCount: Int
    let requiredSubmissions: Int
    let allSubmitted: Bool
    let hasSubmitted: Bool
    let mySelections: [String]
}

struct LobbyGameView: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let revision: Int
    let status: GameStatus
    let practice: Bool
    let isCreator: Bool
    let claimedPlayerCount: Int
    let lobbyCapacity: Int
    let players: [LobbyPlayer]
    let exercises: [HealthGoalRule]
    let categoryTroopCaps: [String: Double]
    let healthRuleGovernance: HealthRuleGovernance
    let healthRulesVersion: Int
    let dailyTotalTroopCap: Double
    let lobbyHealthVoting: LobbyHealthVoting
}

struct HealthRulesUpdateRequest: Codable, Equatable, Sendable {
    let revision: Int
    let exercises: [HealthGoalRule]
    let categoryTroopCaps: [String: Double]
    let dailyTotalTroopCap: Double
}

struct LobbyHealthChoicesRequest: Codable, Equatable, Sendable {
    let revision: Int
    let exerciseKeys: [String]
}

struct LobbyGameMutationResponse: Codable, Equatable, Sendable {
    let game: LobbyGameView
}

struct LeaveGameResponse: Codable, Equatable, Sendable {
    let ok: Bool
    let activeMultiplayerGameId: String?
    let game: GameView
}

enum TurnPhase: String, Codable, CaseIterable, Sendable {
    case reinforce
    case attack
    case fortify
    case done
}

enum GamePlayerStatus: String, Codable, Sendable {
    case active
    case autoPiloted = "auto_piloted"
    case forfeited
    case eliminated
}

struct GameSchedule: Codable, Equatable, Sendable {
    let timezone: String
    let dailyStartMinuteOfDay: Int
    let playerWindowMinutes: Int
    let moveDeadlineAt: String?
    let nextSessionOpensAt: String?
    let missedTurnPolicy: String
}

struct GameplayPlayer: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let status: GamePlayerStatus
    let color: String?
    let pendingReinforcements: Int
    let pendingEliminationReward: Int
    let note: String
    let claimed: Bool
}

struct GameplayContinent: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let label: String
    let bonus: Int
}

struct GameplayTerritory: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let owner: String?
    let armies: Int
    let continent: String
    let neighbors: [String]
    let color: String
}

struct TerritoryCard: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let territoryId: String
    let earnedDay: Int
}

struct GameplayCards: Codable, Equatable, Sendable {
    let hand: [TerritoryCard]
    let tradeSize: Int
    let tradeReward: Int
    let canTrade: Bool
}

struct GameplayFortificationSummary: Codable, Equatable, Sendable {
    let fromId: String
    let toId: String
    let count: Int
}

struct GameplayExerciseProgress: Codable, Identifiable, Equatable, Sendable {
    let key: String
    let label: String
    let unitLabel: String
    let category: HealthCategory
    let trackingType: HealthTrackingType
    let unitsLogged: Double
    let countedUnits: Double
    let unitCap: Double?
    let troopsEarned: Double

    var id: String { key }
}

struct GameplayExerciseDashboard: Codable, Equatable, Sendable {
    let totalTroops: Double
    let dailyCap: Double
    let totalCapApplied: Bool
    let progress: [GameplayExerciseProgress]
}

struct GameplayTurnStartIncome: Codable, Equatable, Sendable {
    let exerciseTroops: Int
    let healthTroopsToday: Int
    let territoryAndContinentTroops: Int
    let eliminationTroops: Int
    let total: Int
}

struct GameplayTurnSummary: Codable, Equatable, Sendable {
    let reinforcementsPlaced: Int
    let placementsMade: Int
    let attacksMade: Int
    let attackerLosses: Int
    let defenderLosses: Int
    let territoriesCaptured: [String]
    let cardsTraded: Int
    let cardPending: Bool
    let fortification: GameplayFortificationSummary?
}

struct GameplayDashboard: Codable, Equatable, Sendable {
    let playerId: String
    let availableReinforcements: Int?
    let turnStart: GameplayTurnStartIncome?
    let cards: GameplayCards
    let turnSummary: GameplayTurnSummary?
    let exercise: GameplayExerciseDashboard?
}

enum HealthLoggingDestination: String, Codable, Sendable {
    case currentMove = "current_move"
    case upcomingMove = "upcoming_move"
    case nextMove = "next_move"
}

struct GameplayHealthLogging: Codable, Equatable, Sendable {
    let allowed: Bool
    let playerId: String?
    let playerName: String?
    let appliesTo: HealthLoggingDestination?
    let reason: String?
}

struct GameplayGame: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let revision: Int
    let practice: Bool
    let status: GameStatus
    let winnerId: String?
    let dayNumber: Int
    let turnOrder: [String]
    let currentPlayerId: String?
    let mySeats: [String]
    let isCreator: Bool
    let yourTurn: Bool
    let dashboard: GameplayDashboard?
    let healthLogging: GameplayHealthLogging?
    let exercises: [HealthGoalRule]?
    let phase: TurnPhase
    let windowExpiresAt: String?
    let nextSessionOpensAt: String?
    let schedule: GameSchedule
    let players: [GameplayPlayer]
    let continents: [GameplayContinent]
    let territories: [GameplayTerritory]
}

extension GameplayGame {
    var currentPlayer: GameplayPlayer? {
        guard let currentPlayerId else { return nil }
        return players.first { $0.id == currentPlayerId }
    }

    var currentPlayerReinforcements: Int {
        currentPlayer?.pendingReinforcements ?? 0
    }
}

struct GameplayMutationResponse: Codable, Equatable, Sendable {
    let game: GameplayGame
    let cardAwarded: TerritoryCard?

    init(game: GameplayGame, cardAwarded: TerritoryCard? = nil) {
        self.game = game
        self.cardAwarded = cardAwarded
    }
}

struct CardTradeMutationResponse: Codable, Equatable, Sendable {
    let remainingBank: Int
    let remainingCards: Int
    let troopsAwarded: Int
    let game: GameplayGame
}

struct ExerciseLogRequest: Codable, Equatable, Sendable {
    let revision: Int
    let exerciseKey: String
    let units: Double
}

struct ExerciseLogMutationResponse: Codable, Equatable, Sendable {
    let deltaTroops: Int
    let dayTotal: Int
    let totalCapApplied: Bool
    let game: GameplayGame
}

enum AttackEndReason: String, Codable, Equatable, Sendable {
    case capture
    case stopLoss = "stop_loss"
    case attackerMinimum = "attacker_min"
}

struct CombatRound: Codable, Equatable, Sendable {
    let attackerDice: [Int]
    let defenderDice: [Int]
    let attackerLosses: Int
    let defenderLosses: Int
    let attackerForceAfter: Int
    let defenderForceAfter: Int
}

struct AttackResult: Codable, Equatable, Sendable {
    let fromId: String
    let toId: String
    let endReason: AttackEndReason
    let captured: Bool
    let rounds: [CombatRound]
    let totalAttackerLosses: Int
    let totalDefenderLosses: Int
    let survivingAttackers: Int
    let remainingDefenders: Int
    let seed: Int
}

struct AttackMutationResponse: Codable, Equatable, Sendable {
    let result: AttackResult
    let game: GameplayGame
}

struct ReinforcementPlacement: Codable, Equatable, Sendable {
    let territoryId: String
    let count: Int
}

struct ReinforcementRequest: Codable, Equatable, Sendable {
    let revision: Int
    let placements: [ReinforcementPlacement]
}

struct AttackRequest: Codable, Equatable, Sendable {
    let revision: Int
    let fromId: String
    let toId: String
    let committedTroops: Int
    let stopLoss: Int
}

struct FortifyRequest: Codable, Equatable, Sendable {
    let revision: Int
    let fromId: String
    let toId: String
    let count: Int
}

struct ChatMessage: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let gameId: String
    let userId: String
    let playerId: String
    let username: String
    let body: String
    let createdAt: String
    let deletedAt: String?
}

struct UserNotification: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let userId: String
    let gameId: String?
    let type: String
    let title: String
    let body: String
    let deepLink: String?
    let createdAt: String
    let readAt: String?
}

enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .bool(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

struct GameView: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let revision: Int
    let status: GameStatus
    let practice: Bool?
    let yourTurn: Bool?
    let players: [[String: JSONValue]]
    let territories: [[String: JSONValue]]
    let chatMessages: [ChatMessage]
    let schedule: [String: JSONValue]?
}

struct GameMutationResponse: Codable, Equatable, Sendable {
    let game: GameView
}

struct RevisionRequest: Codable, Equatable, Sendable {
    let revision: Int
}

struct OkResponse: Codable, Equatable, Sendable {
    let ok: Bool
}
