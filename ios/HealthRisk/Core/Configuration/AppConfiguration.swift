import Foundation

struct AppConfiguration: Equatable, Sendable {
    static let environmentKey = "HEALTHRISK_API_BASE_URL"
    static let bundleKey = "HealthRiskAPIBaseURL"

    let apiBaseURL: URL

    static func live(
        bundle: Bundle = .main,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> AppConfiguration {
        let configuredValue = environment[environmentKey]
            ?? bundle.object(forInfoDictionaryKey: bundleKey) as? String

        guard
            let rawValue = configuredValue?.trimmingCharacters(in: .whitespacesAndNewlines),
            let url = URL(string: rawValue),
            let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            url.host != nil
        else {
            preconditionFailure("Set a valid HTTP(S) HealthRiskAPIBaseURL in the target configuration.")
        }

        return AppConfiguration(apiBaseURL: url)
    }
}
