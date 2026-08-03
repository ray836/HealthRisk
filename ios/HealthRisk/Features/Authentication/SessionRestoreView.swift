import SwiftUI

struct SessionRestoreView: View {
    @ObservedObject var store: AuthenticationStore
    let error: APIError?

    var body: some View {
        ZStack {
            HealthRiskTheme.appBackground

            VStack(spacing: 20) {
                Image(systemName: error == nil ? "shield.lefthalf.filled" : "wifi.exclamationmark")
                    .font(.system(size: 42, weight: .semibold))
                    .foregroundStyle(error == nil ? HealthRiskTheme.accent : HealthRiskTheme.danger)

                if let error {
                    Text("Session check unavailable")
                        .font(.title2.bold())
                    ServerErrorView(error: error)
                    Button("Try Again") {
                        Task { await store.restoreSession() }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(HealthRiskTheme.accent)
                } else {
                    ProgressView("Restoring your session…")
                        .tint(HealthRiskTheme.accent)
                        .foregroundStyle(HealthRiskTheme.text)
                }
            }
            .frame(maxWidth: 420)
            .padding(24)
        }
    }
}
