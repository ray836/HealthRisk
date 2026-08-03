import Foundation

struct RetryPolicy: Sendable {
    let maximumAttempts: Int
    let delay: Duration

    static let standard = RetryPolicy(maximumAttempts: 2, delay: .milliseconds(250))

    func shouldRetry(_ error: APIError, afterAttempt attempt: Int) -> Bool {
        error.retryable && attempt < maximumAttempts
    }
}

protocol RetrySleeping: Sendable {
    func sleep(for duration: Duration) async
}

struct TaskRetrySleeper: RetrySleeping {
    func sleep(for duration: Duration) async {
        try? await Task.sleep(for: duration)
    }
}
