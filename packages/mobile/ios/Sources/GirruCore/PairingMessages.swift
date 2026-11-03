import Foundation

// Pairing steps 3–6 of PROTOCOL.md ("Pairing key", "Pairing request",
// "Check code", "Welcome"). One addition proposed here and not yet in
// PROTOCOL.md: the request's `sig`, which proves the phone holds the key it
// sends (see README "Pairing request signature").

public struct PairingRequest: Codable, Equatable, Sendable {
    /// The phone's identity public key, SPKI DER as base64url.
    public var key: String
    /// "Work iPhone".
    public var name: String
    public var platform: String
    /// APNs device token, hex. Absent until the owner allows notifications.
    public var push: String?
    /// The lifetime the owner would like (30, 60, 90 or 120). nil = no wish;
    /// the computer's approval decides in every case.
    public var lifetimeDays: Int?
    /// base64url(DER ECDSA) by the phone's identity key over `signedText`.
    public var sig: String?

    public init(key: String, name: String, platform: String, push: String?, lifetimeDays: Int?) {
        self.key = key
        self.name = name
        self.platform = platform
        self.push = push
        self.lifetimeDays = lifetimeDays
    }

    /// "girru/v1/preq-sig\n" + pid + "\n" + phone device id + "\n" + nonce,
    /// where nonce is the base64url text of the g1.preq nonce.
    public static func signedText(pairingId: String, phoneId: String, nonce: String) -> Data {
        Data("girru/v1/preq-sig\n\(pairingId)\n\(phoneId)\n\(nonce)".utf8)
    }
}

public struct PairingWelcome: Codable, Equatable, Sendable {
    public var computer: String
    public var phone: String
    /// Per-phone notification key, 32 bytes base64url.
    public var notifyKey: String
    /// nil = never expires.
    public var lifetimeDays: Int?
    public var name: String?
}

public enum PairingMessages {
    /// HKDF-SHA-256(pairing secret, salt = pairing id, info = "girru/v1/pair").
    public static func pairingKey(_ payload: PairingPayload, crypto: PairingCrypto) -> Data {
        crypto.hkdf(payload.pairingSecret, salt: Data(payload.pairingId.utf8), info: Data("girru/v1/pair".utf8), count: 32)
    }

    /// g1.preq.<nonce>.<ciphertext||tag>, AAD "girru/v1/preq\n" + pairing id.
    /// `signer` is the phone's identity; its key goes in `key` and it signs `sig`.
    public static func sealRequest(_ request: PairingRequest, signer: IdentitySigner, payload: PairingPayload, crypto: PairingCrypto) throws -> String {
        let key = pairingKey(payload, crypto: crypto)
        let nonce = crypto.randomBytes(12)
        let nonceText = Base64URL.encode(nonce)
        var signed = request
        signed.key = Base64URL.encode(signer.publicKeySPKI)
        signed.sig = Base64URL.encode(try signer.sign(PairingRequest.signedText(pairingId: payload.pairingId, phoneId: signer.deviceId, nonce: nonceText)))
        let plain = try JSONEncoder().encode(signed)
        let box = try crypto.seal(plain, key: key, nonce: nonce, aad: Data("girru/v1/preq\n\(payload.pairingId)".utf8))
        return "g1.preq.\(nonceText).\(Base64URL.encode(box))"
    }

    /// The computer's side; here for tests and as the Swift reference. Refuses
    /// a request whose `sig` was not made by the key it carries.
    public static func openRequest(_ text: String, payload: PairingPayload, crypto: PairingCrypto) throws -> PairingRequest {
        let (n, b) = try G1Text.split(text, kind: "preq")
        guard let nonce = Base64URL.decode(n), nonce.count == 12, let box = Base64URL.decode(b) else { throw ProtocolError.badFormat }
        let plain = try crypto.open(box, key: pairingKey(payload, crypto: crypto), nonce: nonce, aad: Data("girru/v1/preq\n\(payload.pairingId)".utf8))
        guard let req = try? JSONDecoder().decode(PairingRequest.self, from: plain),
              let spki = Base64URL.decode(req.key), crypto.isValidPublicKey(spki, expectedId: nil) else { throw ProtocolError.badFormat }
        let text = PairingRequest.signedText(pairingId: payload.pairingId, phoneId: DeviceId.of(spki: spki), nonce: n)
        guard let s = req.sig, let sig = Base64URL.decode(s), crypto.verify(signature: sig, message: text, publicKeySPKI: spki) else {
            throw ProtocolError.badSignature
        }
        return req
    }

    /// g1.pwel.<payload>.<sig>; payload = base64url(nonce || ciphertext || tag)
    /// under the pairing key; sig = ECDSA by the computer over
    /// "girru/v1/pwel\n" + payload.
    public static func sealWelcome(_ welcome: PairingWelcome, payload: PairingPayload, computer: IdentitySigner, crypto: PairingCrypto) throws -> String {
        let nonce = crypto.randomBytes(12)
        let box = try crypto.seal(try JSONEncoder().encode(welcome), key: pairingKey(payload, crypto: crypto), nonce: nonce, aad: Data("girru/v1/pwel\n\(payload.pairingId)".utf8))
        let part = Base64URL.encode(nonce + box)
        let sig = try computer.sign(G1Text.signedBytes("pwel", part))
        return "g1.pwel.\(part).\(Base64URL.encode(sig))"
    }

    /// Checks the computer's signature against the key from the QR code first,
    /// then decrypts. A welcome for another phone is refused.
    public static func openWelcome(_ text: String, payload: PairingPayload, phoneId: String, crypto: PairingCrypto) throws -> PairingWelcome {
        let (part, s) = try G1Text.split(text, kind: "pwel")
        guard let sig = Base64URL.decode(s), crypto.verify(signature: sig, message: G1Text.signedBytes("pwel", part), publicKeySPKI: payload.computerKey) else {
            throw ProtocolError.badSignature
        }
        guard let raw = Base64URL.decode(part), raw.count >= 12 + 16 else { throw ProtocolError.badFormat }
        let plain = try crypto.open(raw.dropFirst(12), key: pairingKey(payload, crypto: crypto), nonce: raw.prefix(12), aad: Data("girru/v1/pwel\n\(payload.pairingId)".utf8))
        guard let w = try? JSONDecoder().decode(PairingWelcome.self, from: plain) else { throw ProtocolError.badFormat }
        guard w.computer == payload.computerId, w.phone == phoneId else { throw ProtocolError.wrongTarget }
        guard let nk = Base64URL.decode(w.notifyKey), nk.count == 32 else { throw ProtocolError.badFormat }
        guard PairingLifetime(days: w.lifetimeDays) != nil else { throw ProtocolError.badFormat }
        return w
    }

    /// The 6-digit code both screens show (step 4):
    /// SHA-256("girru/v1/check\n" || secret || computer SPKI || phone SPKI),
    /// first 4 bytes as a big-endian number, mod 1 000 000, zero-padded.
    public static func checkCode(secret: Data, computerKey: Data, phoneKey: Data, crypto: PairingCrypto) -> String {
        let digest = crypto.sha256(Data("girru/v1/check\n".utf8) + secret + computerKey + phoneKey)
        let n = digest.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        let code = String(n % 1_000_000)
        return String(repeating: "0", count: 6 - code.count) + code
    }
}
