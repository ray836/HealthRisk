import XCTest
@testable import HealthRisk

final class KeychainTokenStoreTests: XCTestCase {
    private var store: KeychainTokenStore!

    override func setUpWithError() throws {
        store = KeychainTokenStore(
            service: "com.example.HealthRisk.tests.\(UUID().uuidString)",
            account: "test-session"
        )
    }

    override func tearDownWithError() throws {
        try store.deleteToken()
        store = nil
    }

    func testSaveReadUpdateAndDeleteToken() throws {
        XCTAssertNil(try store.readToken())

        try store.saveToken("first-token")
        XCTAssertEqual(try store.readToken(), "first-token")

        try store.saveToken("replacement-token")
        XCTAssertEqual(try store.readToken(), "replacement-token")

        try store.deleteToken()
        XCTAssertNil(try store.readToken())
    }
}
