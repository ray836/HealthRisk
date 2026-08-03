import SwiftUI

@main
struct HealthRiskApp: App {
    private let api: any HealthRiskAPI
    private let apiBaseURL: URL
    @StateObject private var authenticationStore: AuthenticationStore

    init() {
        let configuration = AppConfiguration.live()
        let api = APIClient(baseURL: configuration.apiBaseURL)
        self.api = api
        self.apiBaseURL = configuration.apiBaseURL
        _authenticationStore = StateObject(
            wrappedValue: AuthenticationStore(
                api: api,
                tokenStore: KeychainTokenStore()
            )
        )
    }

    var body: some Scene {
        WindowGroup {
            RootView(
                authenticationStore: authenticationStore,
                api: api,
                apiBaseURL: apiBaseURL
            )
                .preferredColorScheme(.dark)
                .task { await authenticationStore.restoreSession() }
        }
    }
}
