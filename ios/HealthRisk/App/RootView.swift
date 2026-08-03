import SwiftUI

struct RootView: View {
    @ObservedObject var authenticationStore: AuthenticationStore
    let api: any HealthRiskAPI
    let apiBaseURL: URL

    var body: some View {
        switch authenticationStore.state {
        case .restoring:
            SessionRestoreView(store: authenticationStore, error: nil)
        case .signedOut:
            AuthenticationView(store: authenticationStore)
        case .signedIn:
            MyGamesView(
                api: api,
                apiBaseURL: apiBaseURL,
                authenticationStore: authenticationStore
            )
        case let .restoreFailed(error):
            SessionRestoreView(store: authenticationStore, error: error)
        }
    }
}
