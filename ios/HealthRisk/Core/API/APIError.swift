import Foundation

struct APIError: Error, LocalizedError, Equatable, Sendable {
    let statusCode: Int?
    let code: String
    let message: String
    let requestId: String?
    let retryable: Bool

    var errorDescription: String? { message }
    var isUnauthorized: Bool { statusCode == 401 || statusCode == 403 }

    static func network(requestId: String) -> APIError {
        APIError(
            statusCode: nil,
            code: "network_error",
            message: "Unable to reach the HealthRisk server.",
            requestId: requestId,
            retryable: true
        )
    }

    static func secureStorage(_ error: Error) -> APIError {
        APIError(
            statusCode: nil,
            code: "secure_storage_error",
            message: "The secure session could not be accessed.",
            requestId: nil,
            retryable: false
        )
    }

    static func normalized(_ error: Error) -> APIError {
        if let apiError = error as? APIError { return apiError }
        if error is KeychainError { return .secureStorage(error) }
        return APIError(
            statusCode: nil,
            code: "unexpected_error",
            message: "Something went wrong.",
            requestId: nil,
            retryable: false
        )
    }
}
