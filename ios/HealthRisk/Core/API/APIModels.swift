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
