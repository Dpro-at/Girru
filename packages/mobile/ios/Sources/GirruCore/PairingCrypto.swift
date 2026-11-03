import CryptoKit
import Foundation

// Suite g1 of packages/relay/PROTOCOL.md: ECDSA P-256 / SHA-256 (DER signatures),
// ECDH P-256, HKDF-SHA-256, AES-256-GCM. Public keys travel as SPKI DER.
// P-256 because it is the only curve the Secure Enclave holds.

public enum ProtocolError: Error, Equatable {
    case badFormat
    case wrongKey
    case badSignature
    case badTag
    case stale
    case replay
    case wrongSession
    case wrongTarget
    case sessionExhausted
    case counterExhausted
    case expired
    case tooLarge
}

/// The largest integer both sides can carry in JSON (JavaScript safe integer).
public let maxSafeInteger: UInt64 = (1 << 53) - 1

/// A device's identity key. The Secure Enclave key on a phone and a software
/// key in tests both conform. The private key never leaves the conformer.
///
/// The same key both signs and agrees: PROTOCOL.md "Welcome" wraps the
/// notification key under ECDH(identity key, peer identity key), bound to the
/// SPKI the pairing request carried, so a second key would not open it.
public protocol IdentitySigner: Sendable {
    /// SPKI DER of the P-256 public key.
    var publicKeySPKI: Data { get }
    /// ECDSA P-256 / SHA-256 over `message`, DER encoded.
    func sign(_ message: Data) throws -> Data
    /// ECDH P-256 of this identity key with `peerSPKI` (the 32-byte x
    /// coordinate), then HKDF-SHA-256. The shared secret stays inside.
    func agree(peerSPKI: Data, salt: Data, info: Data, count: Int) throws -> Data
}

public extension IdentitySigner {
    var deviceId: String { DeviceId.of(spki: publicKeySPKI) }
}

public enum DeviceId {
    /// base64url(SHA-256(SPKI DER)).
    public static func of(spki: Data) -> String {
        Base64URL.encode(Data(SHA256.hash(data: spki)))
    }
}

/// Everything beyond the device's own identity. Kept behind a protocol so the
/// g1 bytes have one home and a later suite can sit beside it.
public protocol PairingCrypto: Sendable {
    func verify(signature: Data, message: Data, publicKeySPKI: Data) -> Bool
    /// Checks the key is a P-256 SPKI and, when given, that it matches the id.
    func isValidPublicKey(_ spki: Data, expectedId: String?) -> Bool

    func makeEphemeral() -> EphemeralKey
    /// ECDH + HKDF-SHA-256.
    func derive(ephemeral: EphemeralKey, peerSPKI: Data, salt: Data, info: Data, count: Int) throws -> Data
    func hkdf(_ secret: Data, salt: Data, info: Data, count: Int) -> Data

    /// AES-256-GCM. Returns ciphertext || 16-byte tag (the nonce is not included).
    func seal(_ plaintext: Data, key: Data, nonce: Data, aad: Data) throws -> Data
    func open(_ sealed: Data, key: Data, nonce: Data, aad: Data) throws -> Data

    func sha256(_ data: Data) -> Data
    func randomBytes(_ count: Int) -> Data
}

/// A fresh P-256 key-agreement key for one session.
public struct EphemeralKey: @unchecked Sendable {
    let key: P256.KeyAgreement.PrivateKey
    public var publicKeySPKI: Data { key.publicKey.derRepresentation }
}

public struct CryptoKitPairingCrypto: PairingCrypto {
    public init() {}

    public func verify(signature: Data, message: Data, publicKeySPKI: Data) -> Bool {
        guard let key = try? P256.Signing.PublicKey(derRepresentation: publicKeySPKI),
              let sig = try? P256.Signing.ECDSASignature(derRepresentation: signature) else { return false }
        return key.isValidSignature(sig, for: message)
    }

    public func isValidPublicKey(_ spki: Data, expectedId: String?) -> Bool {
        guard let key = try? P256.Signing.PublicKey(derRepresentation: spki) else { return false }
        // Re-encoding must give the same bytes, so the device id is unambiguous.
        guard key.derRepresentation == spki else { return false }
        if let id = expectedId { return DeviceId.of(spki: spki) == id }
        return true
    }

    public func makeEphemeral() -> EphemeralKey {
        EphemeralKey(key: P256.KeyAgreement.PrivateKey())
    }

    public func derive(ephemeral: EphemeralKey, peerSPKI: Data, salt: Data, info: Data, count: Int) throws -> Data {
        let peer: P256.KeyAgreement.PublicKey
        do { peer = try P256.KeyAgreement.PublicKey(derRepresentation: peerSPKI) } catch { throw ProtocolError.wrongKey }
        let shared = try ephemeral.key.sharedSecretFromKeyAgreement(with: peer)
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt, sharedInfo: info, outputByteCount: count)
        return key.withUnsafeBytes { Data($0) }
    }

    public func hkdf(_ secret: Data, salt: Data, info: Data, count: Int) -> Data {
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: secret), salt: salt, info: info, outputByteCount: count)
        return key.withUnsafeBytes { Data($0) }
    }

    public func seal(_ plaintext: Data, key: Data, nonce: Data, aad: Data) throws -> Data {
        guard key.count == 32, nonce.count == 12 else { throw ProtocolError.badFormat }
        let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: try AES.GCM.Nonce(data: nonce), authenticating: aad)
        return box.ciphertext + box.tag
    }

    public func open(_ sealed: Data, key: Data, nonce: Data, aad: Data) throws -> Data {
        guard key.count == 32, nonce.count == 12, sealed.count >= 16 else { throw ProtocolError.badFormat }
        do {
            let box = try AES.GCM.SealedBox(nonce: try AES.GCM.Nonce(data: nonce), ciphertext: sealed.dropLast(16), tag: sealed.suffix(16))
            return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
        } catch {
            throw ProtocolError.badTag
        }
    }

    public func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

    public func randomBytes(_ count: Int) -> Data {
        // SymmetricKey draws from the system CSPRNG.
        var out = Data()
        while out.count < count {
            out.append(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }.prefix(count - out.count))
        }
        return out
    }
}

/// Software P-256 signer for tests and for the simulator, which has no Secure
/// Enclave. Real phones use the Secure Enclave signer in Storage/.
public struct SoftwareIdentitySigner: IdentitySigner {
    private let key: P256.Signing.PrivateKey

    public init() { key = P256.Signing.PrivateKey() }

    public init(rawPrivateKey: Data) throws {
        do { key = try P256.Signing.PrivateKey(rawRepresentation: rawPrivateKey) } catch { throw ProtocolError.wrongKey }
    }

    public var rawPrivateKey: Data { key.rawRepresentation }
    public var publicKeySPKI: Data { key.publicKey.derRepresentation }

    public func sign(_ message: Data) throws -> Data {
        try key.signature(for: message).derRepresentation
    }

    public func agree(peerSPKI: Data, salt: Data, info: Data, count: Int) throws -> Data {
        let own = try P256.KeyAgreement.PrivateKey(rawRepresentation: key.rawRepresentation)
        return try IdentityAgreement.derive(peerSPKI: peerSPKI, salt: salt, info: info, count: count) { try own.sharedSecretFromKeyAgreement(with: $0) }
    }
}

/// The shared part of `IdentitySigner.agree` for every key store.
public enum IdentityAgreement {
    public static func derive(peerSPKI: Data, salt: Data, info: Data, count: Int, agree: (P256.KeyAgreement.PublicKey) throws -> SharedSecret) throws -> Data {
        let peer: P256.KeyAgreement.PublicKey
        do { peer = try P256.KeyAgreement.PublicKey(derRepresentation: peerSPKI) } catch { throw ProtocolError.wrongKey }
        // A key store error (no unlock, key gone) passes through unchanged.
        let shared = try agree(peer)
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt, sharedInfo: info, outputByteCount: count)
        return key.withUnsafeBytes { Data($0) }
    }
}

/// Builds and reads the dotted g1 texts: "g1.<kind>.<a>.<b>".
enum G1Text {
    static let suite = "g1"

    static func split(_ text: String, kind: String) throws -> (String, String) {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts[0] == suite, parts[1] == kind else { throw ProtocolError.badFormat }
        return (String(parts[2]), String(parts[3]))
    }

    static func json(_ part: String) throws -> [String: Any] {
        guard let data = Base64URL.decode(part),
              let obj = try? JSONSerialization.jsonObject(with: data),
              let dict = obj as? [String: Any] else { throw ProtocolError.badFormat }
        return dict
    }

    static func encode<T: Encodable>(_ value: T) throws -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return Base64URL.encode(try enc.encode(value))
    }

    /// Signatures cover "girru/v1/<context>\n" + the exact base64url text sent.
    static func signedBytes(_ context: String, _ payload: String) -> Data {
        Data("girru/v1/\(context)\n\(payload)".utf8)
    }

    /// Reads a JSON integer that must be a whole, JavaScript-safe number.
    static func integer(_ value: Any?) throws -> UInt64 {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { throw ProtocolError.badFormat }
        let d = n.doubleValue
        guard d >= 0, d <= Double(maxSafeInteger), d.rounded() == d else { throw ProtocolError.badFormat }
        return UInt64(d)
    }

    static func checkTime(_ ts: UInt64, now: Date, window: TimeInterval) throws {
        let nowMs = (now.timeIntervalSince1970 * 1000).rounded()
        guard abs(nowMs - Double(ts)) <= window * 1000 else { throw ProtocolError.stale }
    }

    static func millis(_ date: Date) -> UInt64 {
        UInt64(max(0, (date.timeIntervalSince1970 * 1000).rounded()))
    }
}
