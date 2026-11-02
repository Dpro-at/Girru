import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// The phone's identity key in the Secure Enclave: P-256, non-exportable,
/// usable only with user presence. The app lock's LAContext is passed in so
/// one unlock covers signing until the app locks again.
struct SecureEnclaveSigner: IdentitySigner, @unchecked Sendable {
    private let key: SecureEnclave.P256.Signing.PrivateKey

    init(key: SecureEnclave.P256.Signing.PrivateKey) { self.key = key }

    var publicKeySPKI: Data { key.publicKey.derRepresentation }

    func sign(_ message: Data) throws -> Data {
        try key.signature(for: message).derRepresentation
    }
}

enum DeviceIdentity {
    private static let account = "identity-key"
    private static let softwareAccount = "identity-key-software"

    /// Loads the identity, creating it on first use. `context` must already be
    /// evaluated (the app lock does that); otherwise iOS prompts.
    static func loadOrCreate(context: LAContext, store: KeychainStore = .shared) throws -> IdentitySigner {
        if SecureEnclave.isAvailable {
            // The stored blob is the key wrapped by this phone's Secure Enclave:
            // useless anywhere else, so it needs no extra access control.
            if let blob = try store.get(account: account) {
                return SecureEnclaveSigner(key: try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context))
            }
            var error: Unmanaged<CFError>?
            guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &error) else {
                throw KeychainError.accessControl
            }
            let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access, authenticationContext: context)
            try store.set(key.dataRepresentation, account: account, protection: .whenUnlocked)
            return SecureEnclaveSigner(key: key)
        }
        // Simulator only: a software key, readable only with user presence.
        if let raw = try store.get(account: softwareAccount, context: context) {
            return try SoftwareIdentitySigner(rawPrivateKey: raw)
        }
        let key = SoftwareIdentitySigner()
        try store.set(key.rawPrivateKey, account: softwareAccount, protection: .userPresence)
        return key
    }

    /// "Remove this phone" on the phone: the key is gone, pairing must start over.
    static func destroy(store: KeychainStore = .shared) {
        store.delete(account: account)
        store.delete(account: softwareAccount)
    }
}
