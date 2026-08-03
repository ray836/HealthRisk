import Combine
import Foundation

@MainActor
final class AuthenticationStore: ObservableObject {
    enum State: Equatable {
        case restoring
        case signedOut
        case signedIn(PublicUser)
        case restoreFailed(APIError)
    }

    @Published private(set) var state: State = .restoring
    @Published private(set) var isSubmitting = false
    @Published var error: APIError?

    private let api: any HealthRiskAPI
    private let tokenStore: any TokenStore

    init(api: any HealthRiskAPI, tokenStore: any TokenStore) {
        self.api = api
        self.tokenStore = tokenStore
    }

    func restoreSession() async {
        state = .restoring
        error = nil

        do {
            guard let token = try tokenStore.readToken() else {
                await api.setBearerToken(nil)
                state = .signedOut
                return
            }

            await api.setBearerToken(token)
            let response = try await api.currentUser()
            if let user = response.user {
                state = .signedIn(user)
            } else {
                try tokenStore.deleteToken()
                await api.setBearerToken(nil)
                state = .signedOut
            }
        } catch {
            let normalized = APIError.normalized(error)
            self.error = normalized
            state = .restoreFailed(normalized)
        }
    }

    func login(username: String, password: String) async {
        await authenticate(username: username, password: password, createAccount: false)
    }

    func signup(username: String, password: String) async {
        await authenticate(username: username, password: password, createAccount: true)
    }

    func signOut() async {
        isSubmitting = true
        error = nil
        var signOutError: APIError?

        do {
            try await api.logout()
        } catch {
            signOutError = APIError.normalized(error)
        }

        do {
            try tokenStore.deleteToken()
        } catch {
            signOutError = signOutError ?? APIError.normalized(error)
        }

        await api.setBearerToken(nil)
        state = .signedOut
        error = signOutError
        isSubmitting = false
    }

    func invalidateSession() async {
        try? tokenStore.deleteToken()
        await api.setBearerToken(nil)
        state = .signedOut
    }

    private func authenticate(
        username: String,
        password: String,
        createAccount: Bool
    ) async {
        isSubmitting = true
        error = nil

        do {
            let credentials = AuthRequest(
                username: username.trimmingCharacters(in: .whitespacesAndNewlines),
                password: password
            )
            let response = try await (createAccount
                ? api.signup(credentials)
                : api.login(credentials))

            do {
                try tokenStore.saveToken(response.token)
            } catch {
                // Revoke the just-created session when it cannot be persisted.
                await api.setBearerToken(response.token)
                try? await api.logout()
                await api.setBearerToken(nil)
                throw error
            }

            await api.setBearerToken(response.token)
            state = .signedIn(response.user)
        } catch {
            self.error = APIError.normalized(error)
            state = .signedOut
        }

        isSubmitting = false
    }
}
