import Foundation
import Security

protocol TokenStore: Sendable {
    func readToken() throws -> String?
    func saveToken(_ token: String) throws
    func deleteToken() throws
}

struct KeychainError: Error, LocalizedError, Equatable, Sendable {
    let operation: String
    let status: OSStatus

    var errorDescription: String? {
        "Keychain \(operation) failed (OSStatus \(status))."
    }
}

struct KeychainTokenStore: TokenStore {
    private let service: String
    private let account: String

    init(
        service: String = Bundle.main.bundleIdentifier ?? "HealthRisk",
        account: String = "bearer-session"
    ) {
        self.service = service
        self.account = account
    }

    func readToken() throws -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = kCFBooleanTrue
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw KeychainError(operation: "read", status: status)
        }
        guard
            let data = result as? Data,
            let token = String(data: data, encoding: .utf8)
        else {
            throw KeychainError(operation: "decode", status: errSecDecode)
        }
        return token
    }

    func saveToken(_ token: String) throws {
        let data = Data(token.utf8)
        let attributes: [String: Any] = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)

        if updateStatus == errSecItemNotFound {
            var item = baseQuery
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(item as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainError(operation: "save", status: addStatus)
            }
            return
        }

        guard updateStatus == errSecSuccess else {
            throw KeychainError(operation: "update", status: updateStatus)
        }
    }

    func deleteToken() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(operation: "delete", status: status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
