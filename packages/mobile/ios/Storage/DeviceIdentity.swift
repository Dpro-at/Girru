import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// The phone's identity key in the Secure Enclave: P-256, non-exportable,
/// usable only with user presence. The app lock's LAContext is passed in so
/// one unlock covers signing until the app locks again.
///
/// PROTOCOL.md wraps the notification key under ECDH with this same identity
/// key (bound to the SPKI the pairing request sent), so one Secure Enclave key
/// both signs and agrees. CryptoKit has a separate type for each use; both are
/// opened from the same wrapped blob, and the two public keys must be equal,
/// else the identity is refused rather than replaced by a second key.
struct SecureEnclaveSigner: IdentitySigner, @unchecked Sendable {
    private let key: SecureEnclave.P256.Signing.PrivateKey
    private let agreement: SecureEnclave.P256.KeyAgreement.PrivateKey

    init(blob: Data, context: LAContext) throws {
        key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context)
        do {
            agreement = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob, authenticationContext: context)
        } catch {
            throw IdentityError.keyAgreementUnavailable
        }
        guard agreement.publicKey.derRepresentation == key.publicKey.derRepresentation else { throw IdentityError.keyAgreementUnavailable }
    }

    var publicKeySPKI: Data { key.publicKey.derRepresentation }

    func sign(_ message: Data) throws -> Data {
        try key.signature(for: message).derRepresentation
    }

    func agree(peerSPKI: Data, salt: Data, info: Data, count: Int) throws -> Data {
        try IdentityAgreement.derive(peerSPKI: peerSPKI, salt: salt, info: info, count: count) { try agreement.sharedSecretFromKeyAgreement(with: $0) }
    }
}

enum IdentityError: LocalizedError {
    /// The Secure Enclave key cannot also do key agreement. Pairing cannot
    /// finish; nothing falls back to a weaker key.
    case keyAgreementUnavailable

    var errorDescription: String? {
        "This iPhone cannot finish pairing with its secure key."
    }
}

enum DeviceIdentity {
    private static let account = "identity-key"
    private static let softwareAccount = "identity-key-software"

    /// Loads the identity, creating it on first use. `context` must already be
    /// evaluated (the app lock does that); otherwise iOS prompts.
    static func loadOrCreate(context: LAContext, store: KeychainStore = .shared) throws -> IdentitySigner {
        // The simulator can report a Secure Enclave but cannot make a key bound to
        // user presence in it, so it always takes the software path below.
        #if targetEnvironment(simulator)
        let useSecureEnclave = false
        #else
        let useSecureEnclave = SecureEnclave.isAvailable
        #endif
        if useSecureEnclave {
            // The stored blob is the key wrapped by this phone's Secure Enclave:
            // useless anywhere else, so it needs no extra access control.
            if let blob = try store.get(account: account) {
                return try SecureEnclaveSigner(blob: blob, context: context)
            }
            var error: Unmanaged<CFError>?
            guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &error) else {
                throw KeychainError.accessControl
            }
            let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access, authenticationContext: context)
            // Checked before it is stored, so an identity that cannot agree is never kept.
            let signer = try SecureEnclaveSigner(blob: key.dataRepresentation, context: context)
            try store.set(key.dataRepresentation, account: account, protection: .whenUnlocked)
            return signer
        }
        // No Secure Enclave: a software key, readable only with user presence.
        // The iOS Simulator cannot make user-presence items (LocalAuthentication
        // -1020, "not supported on iOS Simulator"), so there, and only there, the
        // key is readable while the simulator is unlocked. The app lock still
        // runs; a real iPhone always takes the Secure Enclave path above.
        #if targetEnvironment(simulator)
        let protection: KeychainStore.Protection = .whenUnlocked
        let readContext: LAContext? = nil
        #else
        let protection: KeychainStore.Protection = .userPresence
        let readContext: LAContext? = context
        #endif
        if let raw = try store.get(account: softwareAccount, context: readContext) {
            return try SoftwareIdentitySigner(rawPrivateKey: raw)
        }
        let key = SoftwareIdentitySigner()
        try store.set(key.rawPrivateKey, account: softwareAccount, protection: protection)
        return key
    }

    /// "Remove this phone" on the phone: the key is gone, pairing must start over.
    static func destroy(store: KeychainStore = .shared) {
        store.delete(account: account)
        store.delete(account: softwareAccount)
    }
}
