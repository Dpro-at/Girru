import Foundation
import LocalAuthentication
import Security

enum KeychainError: Error, Equatable {
    case status(OSStatus)
    case accessControl
}

/// Thin wrapper over generic-password items. Every item is "this device only",
/// so nothing goes into iCloud Keychain or an encrypted backup restore.
struct KeychainStore {
    let service: String
    /// Shared with the notification extension (keychain-access-groups).
    let accessGroup: String?

    /// The group from Info.plist (GirruKeychainGroup = $(AppIdentifierPrefix)…).
    static var sharedGroup: String? {
        Bundle.main.object(forInfoDictionaryKey: "GirruKeychainGroup") as? String
    }

    static let shared = KeychainStore(service: "dev.girru.shared", accessGroup: KeychainStore.sharedGroup)

    enum Protection {
        /// Readable only while the phone is unlocked.
        case whenUnlocked
        /// Readable after the first unlock since boot; needed by the
        /// notification extension, which runs while the phone is locked.
        case afterFirstUnlock
        /// Every read asks for Face ID / Touch ID / passcode (or an already
        /// evaluated LAContext).
        case userPresence
    }

    func set(_ data: Data, account: String, protection: Protection) throws {
        var query = baseQuery(account)
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = data
        switch protection {
        case .whenUnlocked:
            query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        case .afterFirstUnlock:
            query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        case .userPresence:
            var error: Unmanaged<CFError>?
            guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .userPresence, &error) else {
                throw KeychainError.accessControl
            }
            query[kSecAttrAccessControl as String] = access
        }
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.status(status) }
    }

    /// nil when there is no item. `context` lets a user-presence item use the
    /// app lock's evaluation instead of prompting again.
    func get(account: String, context: LAContext? = nil) throws -> Data? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        if let context { query[kSecUseAuthenticationContext as String] = context }
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError.status(status) }
        return out as? Data
    }

    func delete(account: String) {
        SecItemDelete(baseQuery(account) as CFDictionary)
    }

    private func baseQuery(_ account: String) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            // Same behaviour on macOS as on iOS; ignored on iOS.
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }
}
