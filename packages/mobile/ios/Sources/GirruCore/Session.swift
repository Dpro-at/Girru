import Foundation

// Session handshake (hs1 → hs2) and the g1.msg envelope, PROTOCOL.md
// "Session handshake" and "Envelope". Byte for byte the same as the
// computer's reference code (packages/relay/src/e2e.ts).

/// Accepted clock difference for handshakes and commands.
public let protocolWindow: TimeInterval = 2 * 60

public struct Session: Sendable {
    public let id: String
    public let selfId: String
    public let peerId: String
    let sendKey: Data
    let recvKey: Data
    public private(set) var sendSeq: UInt64 = 0
    public private(set) var recvSeq: UInt64 = 0

    init(id: String, selfId: String, peerId: String, sendKey: Data, recvKey: Data) {
        self.id = id
        self.selfId = selfId
        self.peerId = peerId
        self.sendKey = sendKey
        self.recvKey = recvKey
    }

    static func nonce(_ seq: UInt64) -> Data {
        var out = Data(count: 4)
        withUnsafeBytes(of: seq.bigEndian) { out.append(contentsOf: $0) }
        return out
    }

    private struct Header: Codable { let sid: String; let seq: UInt64; let from: String; let to: String }

    public mutating func seal(_ plaintext: Data, crypto: PairingCrypto) throws -> String {
        guard sendSeq < maxSafeInteger else { throw ProtocolError.sessionExhausted }
        let seq = sendSeq + 1
        let header = try G1Text.encode(Header(sid: id, seq: seq, from: selfId, to: peerId))
        let body = try crypto.seal(plaintext, key: sendKey, nonce: Self.nonce(seq), aad: Data(header.utf8))
        sendSeq = seq
        return "g1.msg.\(header).\(Base64URL.encode(body))"
    }

    /// The counter moves only after the tag checks, so a forged envelope
    /// cannot block real ones.
    public mutating func open(_ envelope: String, crypto: PairingCrypto) throws -> Data {
        let (header, bodyText) = try G1Text.split(envelope, kind: "msg")
        let h = try G1Text.json(header)
        guard h["sid"] as? String == id, h["from"] as? String == peerId, h["to"] as? String == selfId else {
            throw ProtocolError.wrongSession
        }
        let seq = try G1Text.integer(h["seq"])
        guard seq >= 1 else { throw ProtocolError.badFormat }
        guard seq > recvSeq else { throw ProtocolError.replay }
        guard let body = Base64URL.decode(bodyText), body.count >= 16 else { throw ProtocolError.badFormat }
        let plain = try crypto.open(body, key: recvKey, nonce: Self.nonce(seq), aad: Data(header.utf8))
        recvSeq = seq
        return plain
    }
}

/// The opener's state between hs1 and hs2.
public struct PendingHandshake: Sendable {
    public let selfId: String
    public let peerId: String
    let ephemeral: EphemeralKey
    public let hello: String
}

public enum Handshake {
    private struct Hello: Codable { let from: String; let to: String; let eph: String; let ts: UInt64; let nonce: String }
    private struct Reply: Codable { let from: String; let to: String; let eph: String; let ts: UInt64; let h1: String }

    /// Step 1, run by the phone: a signed hello with a fresh ephemeral key.
    public static func start(signer: IdentitySigner, peerId: String, crypto: PairingCrypto, now: Date = Date()) throws -> PendingHandshake {
        guard Base64URL.isId(peerId) else { throw ProtocolError.badFormat }
        let eph = crypto.makeEphemeral()
        let payload = try G1Text.encode(Hello(from: signer.deviceId, to: peerId, eph: Base64URL.encode(eph.publicKeySPKI), ts: G1Text.millis(now), nonce: Base64URL.encode(crypto.randomBytes(16))))
        let sig = try signer.sign(G1Text.signedBytes("hs1", payload))
        return PendingHandshake(selfId: signer.deviceId, peerId: peerId, ephemeral: eph, hello: "g1.hs1.\(payload).\(Base64URL.encode(sig))")
    }

    /// Step 2, run by the computer. Here for tests and as the Swift reference.
    public static func answer(signer: IdentitySigner, peerSPKI: Data, hello: String, crypto: PairingCrypto, now: Date = Date()) throws -> (reply: String, session: Session) {
        let (payload, sig) = try G1Text.split(hello, kind: "hs1")
        try checkSignature(crypto, "hs1", payload, sig, peerSPKI)
        let h = try G1Text.json(payload)
        let peerId = DeviceId.of(spki: peerSPKI)
        guard h["from"] as? String == peerId, h["to"] as? String == signer.deviceId, let ephText = h["eph"] as? String else {
            throw ProtocolError.badFormat
        }
        try G1Text.checkTime(try G1Text.integer(h["ts"]), now: now, window: protocolWindow)
        guard let peerEph = Base64URL.decode(ephText) else { throw ProtocolError.badFormat }

        let eph = crypto.makeEphemeral()
        let reply = try G1Text.encode(Reply(from: signer.deviceId, to: peerId, eph: Base64URL.encode(eph.publicKeySPKI), ts: G1Text.millis(now), h1: Base64URL.encode(crypto.sha256(Data(hello.utf8)))))
        let session = try derive(crypto, selfId: signer.deviceId, peerId: peerId, opener: false, eph: eph, peerEph: peerEph, hello: hello, replyPayload: reply)
        let replySig = try signer.sign(G1Text.signedBytes("hs2", reply))
        return ("g1.hs2.\(reply).\(Base64URL.encode(replySig))", session)
    }

    /// Step 3, run by the phone: checks the computer's reply against the key
    /// stored at pairing and derives the session.
    public static func finish(_ pending: PendingHandshake, peerSPKI: Data, reply: String, crypto: PairingCrypto, now: Date = Date()) throws -> Session {
        let (payload, sig) = try G1Text.split(reply, kind: "hs2")
        try checkSignature(crypto, "hs2", payload, sig, peerSPKI)
        guard DeviceId.of(spki: peerSPKI) == pending.peerId else { throw ProtocolError.wrongKey }
        let r = try G1Text.json(payload)
        guard r["from"] as? String == pending.peerId, r["to"] as? String == pending.selfId, let ephText = r["eph"] as? String else {
            throw ProtocolError.badFormat
        }
        guard r["h1"] as? String == Base64URL.encode(crypto.sha256(Data(pending.hello.utf8))) else { throw ProtocolError.badFormat }
        try G1Text.checkTime(try G1Text.integer(r["ts"]), now: now, window: protocolWindow)
        guard let peerEph = Base64URL.decode(ephText) else { throw ProtocolError.badFormat }
        return try derive(crypto, selfId: pending.selfId, peerId: pending.peerId, opener: true, eph: pending.ephemeral, peerEph: peerEph, hello: pending.hello, replyPayload: payload)
    }

    private static func checkSignature(_ crypto: PairingCrypto, _ context: String, _ payload: String, _ sig: String, _ spki: Data) throws {
        guard let s = Base64URL.decode(sig), crypto.verify(signature: s, message: G1Text.signedBytes(context, payload), publicKeySPKI: spki) else {
            throw ProtocolError.badSignature
        }
    }

    private static func derive(_ crypto: PairingCrypto, selfId: String, peerId: String, opener: Bool, eph: EphemeralKey, peerEph: Data, hello: String, replyPayload: String) throws -> Session {
        let transcript = crypto.sha256(Data("\(hello)\n\(replyPayload)".utf8))
        let okm = try crypto.derive(ephemeral: eph, peerSPKI: peerEph, salt: transcript, info: Data("girru/v1/session".utf8), count: 64)
        let openerToAnswerer = okm.prefix(32)
        let answererToOpener = okm.suffix(32)
        return Session(id: Base64URL.encode(transcript.prefix(16)), selfId: selfId, peerId: peerId,
                       sendKey: Data(opener ? openerToAnswerer : answererToOpener),
                       recvKey: Data(opener ? answererToOpener : openerToAnswerer))
    }
}
