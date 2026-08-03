import XCTest
@testable import HealthRisk

@MainActor
final class AuthenticationStoreTests: XCTestCase {
    func testRestoreWithoutStoredTokenBecomesSignedOutWithoutCallingMe() async {
        let api = MockHealthRiskAPI()
        let tokens = MemoryTokenStore()
        let store = AuthenticationStore(api: api, tokenStore: tokens)

        await store.restoreSession()

        XCTAssertEqual(store.state, .signedOut)
        let currentUserCallCount = await api.recordedCurrentUserCallCount()
        XCTAssertEqual(currentUserCallCount, 0)
    }

    func testRestoreValidTokenUsesMeAndBecomesSignedIn() async {
        let user = PublicUser(id: "u1", username: "ray")
        let api = MockHealthRiskAPI(
            currentUserResult: .success(
                CurrentUserResponse(user: user, activeMultiplayerGameId: "game-1")
            )
        )
        let tokens = MemoryTokenStore(token: "stored-token")
        let store = AuthenticationStore(api: api, tokenStore: tokens)

        await store.restoreSession()

        XCTAssertEqual(store.state, .signedIn(user))
        let installedTokens = await api.recordedBearerTokens()
        XCTAssertEqual(installedTokens.count, 1)
        XCTAssertEqual(installedTokens[0], "stored-token")
    }

    func testRestoreRejectedTokenClearsSecureStorage() async throws {
        let api = MockHealthRiskAPI(
            currentUserResult: .success(
                CurrentUserResponse(user: nil, activeMultiplayerGameId: nil)
            )
        )
        let tokens = MemoryTokenStore(token: "expired-token")
        let store = AuthenticationStore(api: api, tokenStore: tokens)

        await store.restoreSession()

        XCTAssertEqual(store.state, .signedOut)
        XCTAssertNil(try tokens.readToken())
        XCTAssertEqual(tokens.deleteCount, 1)
    }

    func testLoginPersistsTokenBeforePublishingSignedInState() async throws {
        let user = PublicUser(id: "u1", username: "ray")
        let api = MockHealthRiskAPI(
            loginResult: .success(AuthResponse(token: "new-token", user: user))
        )
        let tokens = MemoryTokenStore()
        let store = AuthenticationStore(api: api, tokenStore: tokens)

        await store.login(username: " ray ", password: "password123")

        XCTAssertEqual(store.state, .signedIn(user))
        XCTAssertEqual(try tokens.readToken(), "new-token")
        XCTAssertEqual(tokens.saveCount, 1)
    }
}
