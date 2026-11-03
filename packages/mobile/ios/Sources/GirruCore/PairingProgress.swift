import Foundation

/// One pairing on the phone, from the scan to the welcome (PROTOCOL.md
/// "Pairing", steps 2–6). It holds the rules the screens follow:
///
/// - The sealed `g1.preq` is made once and resent unchanged, so the computer
///   answers a resend with the same challenge.
/// - No check code exists before a valid `g1.pchal` for this phone. A second
///   challenge must be the same one; a different one ends the pairing.
/// - A welcome is refused until a code was shown: the owner cannot have
///   compared codes otherwise.
/// - The QR code renews on the computer every 2 minutes. Until the challenge
///   arrives, a passed `exp` ends this attempt and the owner scans the new
///   code; once the challenge is in, the computer finishes this pairing even
///   though the code on its screen renewed.
public struct PairingProgress: Sendable {
    public enum Stage: Equatable, Sendable {
        case scanned
        case requestSent
        case codeShown(String)
        case paired
    }

    /// The plain text shown when the scanned code ran out.
    public static let expiredMessage = "This code has expired. Your computer shows a new one: scan it."

    public let payload: PairingPayload
    public let phoneKey: Data
    public let phoneId: String
    public private(set) var stage: Stage = .scanned
    /// The sealed request, kept to resend byte for byte.
    public private(set) var request: String?
    public private(set) var challenge: Data?

    public init(payload: PairingPayload, phoneKey: Data) {
        self.payload = payload
        self.phoneKey = phoneKey
        self.phoneId = DeviceId.of(spki: phoneKey)
    }

    /// True while the scanned code still counts: always once a challenge came,
    /// else only before `exp`.
    public func isCurrent(now: Date = Date()) -> Bool {
        challenge != nil || now < payload.expiresAt
    }

    /// Seals the request on first use; later calls return the same text.
    public mutating func requestText(_ request: PairingRequest, signer: IdentitySigner, crypto: PairingCrypto, now: Date = Date()) throws -> String {
        if let sent = self.request { return sent }
        guard signer.publicKeySPKI == phoneKey else { throw ProtocolError.wrongKey }
        guard isCurrent(now: now) else { throw ProtocolError.expired }
        let text = try PairingMessages.sealRequest(request, signer: signer, payload: payload, crypto: crypto)
        self.request = text
        stage = .requestSent
        return text
    }

    /// Opens the computer's challenge and returns the check code to show.
    public mutating func receiveChallenge(_ text: String, crypto: PairingCrypto, now: Date = Date()) throws -> String {
        guard request != nil else { throw ProtocolError.badFormat }
        let c = try PairingMessages.openChallenge(text, payload: payload, phoneId: phoneId, crypto: crypto)
        if let known = challenge {
            guard known == c else { throw ProtocolError.wrongTarget }
        } else {
            guard isCurrent(now: now) else { throw ProtocolError.expired }
            challenge = c
        }
        let code = try PairingMessages.checkCode(secret: payload.pairingSecret, computerKey: payload.computerKey, phoneKey: phoneKey, challenge: c, crypto: crypto)
        stage = .codeShown(code)
        return code
    }

    /// Opens the welcome once a code was shown; unwraps the notification key
    /// with the phone's identity key.
    public mutating func receiveWelcome(_ text: String, phone: IdentitySigner, crypto: PairingCrypto) throws -> PairingWelcome {
        guard case .codeShown = stage else { throw ProtocolError.badFormat }
        guard phone.publicKeySPKI == phoneKey else { throw ProtocolError.wrongKey }
        let w = try PairingMessages.openWelcome(text, payload: payload, phone: phone, crypto: crypto)
        stage = .paired
        return w
    }
}
