import Foundation

// Pairing steps 3–6 of PROTOCOL.md ("Pairing key", "Pairing request",
// "Check challenge", "Check code", "Welcome"). Byte for byte the same as the
// computer's reference code (packages/backend/src/phone/protocol/pairing.ts).

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
    /// Per-phone notification key. On the wire: 60 bytes base64url (nonce,
    /// wrapped key, tag). After `openWelcome`: the raw 32 bytes, base64url.
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

    // MARK: Check challenge (g1.pchal)

    /// The challenge is exactly 32 bytes.
    public static let challengeBytes = 32

    /// The computer's side; here for tests and as the Swift reference. A fresh
    /// random challenge for the phone whose request it took, sealed under the
    /// pairing key (AAD "girru/v1/pchal\n" + pairing id) and signed over
    /// "girru/v1/pchal\n" + payload.
    public static func sealChallenge(payload: PairingPayload, computer: IdentitySigner, phoneId: String, crypto: PairingCrypto, challenge: Data? = nil) throws -> (text: String, challenge: Data) {
        let bytes = challenge ?? crypto.randomBytes(challengeBytes)
        guard bytes.count == challengeBytes else { throw ProtocolError.badFormat }
        let body = try JSONSerialization.data(withJSONObject: ["computer": computer.deviceId, "phone": phoneId, "challenge": Base64URL.encode(bytes)], options: [.sortedKeys])
        let nonce = crypto.randomBytes(12)
        let box = try crypto.seal(body, key: pairingKey(payload, crypto: crypto), nonce: nonce, aad: Data("girru/v1/pchal\n\(payload.pairingId)".utf8))
        let part = Base64URL.encode(nonce + box)
        let sig = try computer.sign(G1Text.signedBytes("pchal", part))
        return ("g1.pchal.\(part).\(Base64URL.encode(sig))", bytes)
    }

    /// The phone's side: the signature first (against `ck` from the QR code),
    /// then the box, then both ids and the length. Returns the raw challenge.
    /// Anything wrong and no check code may be shown.
    public static func openChallenge(_ text: String, payload: PairingPayload, phoneId: String, crypto: PairingCrypto) throws -> Data {
        let (part, s) = try G1Text.split(text, kind: "pchal")
        guard let sig = Base64URL.decode(s), crypto.verify(signature: sig, message: G1Text.signedBytes("pchal", part), publicKeySPKI: payload.computerKey) else {
            throw ProtocolError.badSignature
        }
        guard let raw = Base64URL.decode(part), raw.count >= 12 + 16 else { throw ProtocolError.badFormat }
        let plain = try crypto.open(raw.dropFirst(12), key: pairingKey(payload, crypto: crypto), nonce: raw.prefix(12), aad: Data("girru/v1/pchal\n\(payload.pairingId)".utf8))
        guard let obj = try? JSONSerialization.jsonObject(with: plain), let c = obj as? [String: Any] else { throw ProtocolError.badFormat }
        guard c["computer"] as? String == payload.computerId, c["phone"] as? String == phoneId else { throw ProtocolError.wrongTarget }
        guard let t = c["challenge"] as? String, let challenge = Base64URL.decode(t), challenge.count == challengeBytes else { throw ProtocolError.badFormat }
        return challenge
    }

    /// The 6-digit code both screens show (step 4):
    /// SHA-256("girru/v1/check\n" || secret || computer SPKI || phone SPKI || challenge),
    /// first 4 bytes as a big-endian number, mod 1 000 000, zero-padded.
    /// There is no code without a 32-byte challenge from g1.pchal.
    public static func checkCode(secret: Data, computerKey: Data, phoneKey: Data, challenge: Data, crypto: PairingCrypto) throws -> String {
        guard challenge.count == challengeBytes else { throw ProtocolError.badFormat }
        let digest = crypto.sha256(Data("girru/v1/check\n".utf8) + secret + computerKey + phoneKey + challenge)
        let n = digest.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        let code = String(n % 1_000_000)
        return String(repeating: "0", count: 6 - code.count) + code
    }

    // MARK: Welcome (g1.pwel)

    /// Nonce (12) + wrapped 32-byte key + tag (16).
    public static let wrappedNotifyKeyBytes = 12 + 32 + 16

    /// HKDF-SHA-256(ECDH(own identity, peer identity), salt = pairing key,
    /// info = "girru/v1/nkey", 32 bytes). The pairing key alone (all a photo
    /// of the QR code gives) cannot make it.
    static func notifyWrapKey(own: IdentitySigner, peerSPKI: Data, payload: PairingPayload, crypto: PairingCrypto) throws -> Data {
        try own.agree(peerSPKI: peerSPKI, salt: pairingKey(payload, crypto: crypto), info: Data("girru/v1/nkey".utf8), count: 32)
    }

    static func notifyKeyAAD(computerId: String, phoneId: String) -> Data {
        Data("girru/v1/nkey\n\(computerId)\n\(phoneId)".utf8)
    }

    /// The computer's side; here for tests and as the Swift reference.
    /// `welcome.notifyKey` is the raw 32-byte key (base64url); it travels
    /// wrapped for `phoneKey`, the key from the pairing request.
    /// g1.pwel.<payload>.<sig>; payload = base64url(nonce || ciphertext || tag)
    /// under the pairing key; sig = ECDSA by the computer over
    /// "girru/v1/pwel\n" + payload.
    public static func sealWelcome(_ welcome: PairingWelcome, payload: PairingPayload, computer: IdentitySigner, phoneKey: Data, crypto: PairingCrypto) throws -> String {
        guard DeviceId.of(spki: phoneKey) == welcome.phone else { throw ProtocolError.wrongKey }
        guard let raw = Base64URL.decode(welcome.notifyKey), raw.count == 32 else { throw ProtocolError.badFormat }
        let kn = crypto.randomBytes(12)
        let wrap = try notifyWrapKey(own: computer, peerSPKI: phoneKey, payload: payload, crypto: crypto)
        var wire = welcome
        wire.notifyKey = Base64URL.encode(kn + (try crypto.seal(raw, key: wrap, nonce: kn, aad: notifyKeyAAD(computerId: welcome.computer, phoneId: welcome.phone))))
        let nonce = crypto.randomBytes(12)
        let box = try crypto.seal(try JSONEncoder().encode(wire), key: pairingKey(payload, crypto: crypto), nonce: nonce, aad: Data("girru/v1/pwel\n\(payload.pairingId)".utf8))
        let part = Base64URL.encode(nonce + box)
        let sig = try computer.sign(G1Text.signedBytes("pwel", part))
        return "g1.pwel.\(part).\(Base64URL.encode(sig))"
    }

    /// Checks the computer's signature against the key from the QR code first,
    /// then decrypts, then the ids, the wrapped key's length and the lifetime,
    /// and last unwraps the notification key with this phone's identity key
    /// (`phone`). Returns the welcome with the raw 32-byte key.
    public static func openWelcome(_ text: String, payload: PairingPayload, phone: IdentitySigner, crypto: PairingCrypto) throws -> PairingWelcome {
        let (part, s) = try G1Text.split(text, kind: "pwel")
        guard let sig = Base64URL.decode(s), crypto.verify(signature: sig, message: G1Text.signedBytes("pwel", part), publicKeySPKI: payload.computerKey) else {
            throw ProtocolError.badSignature
        }
        guard let raw = Base64URL.decode(part), raw.count >= 12 + 16 else { throw ProtocolError.badFormat }
        let plain = try crypto.open(raw.dropFirst(12), key: pairingKey(payload, crypto: crypto), nonce: raw.prefix(12), aad: Data("girru/v1/pwel\n\(payload.pairingId)".utf8))
        guard var w = try? JSONDecoder().decode(PairingWelcome.self, from: plain) else { throw ProtocolError.badFormat }
        let phoneId = phone.deviceId
        guard w.computer == payload.computerId, w.phone == phoneId else { throw ProtocolError.wrongTarget }
        guard let wrapped = Base64URL.decode(w.notifyKey), wrapped.count == wrappedNotifyKeyBytes else { throw ProtocolError.badFormat }
        guard PairingLifetime(days: w.lifetimeDays) != nil else { throw ProtocolError.badFormat }
        let wrap = try notifyWrapKey(own: phone, peerSPKI: payload.computerKey, payload: payload, crypto: crypto)
        let key = try crypto.open(wrapped.dropFirst(12), key: wrap, nonce: wrapped.prefix(12), aad: notifyKeyAAD(computerId: w.computer, phoneId: phoneId))
        guard key.count == 32 else { throw ProtocolError.badFormat }
        w.notifyKey = Base64URL.encode(key)
        return w
    }
}
