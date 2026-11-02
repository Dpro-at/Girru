import Foundation

// Push notices, PROTOCOL.md "Notifications": sealed with the per-phone
// notification key and signed by the computer. The text form is this app's
// proposal (not yet in PROTOCOL.md):
//
//   g1.ntf.<payload>.<sig>
//   payload = base64url(JSON {from, to, ctr, ts, box})
//   box     = base64url(nonce(12) || AES-256-GCM ciphertext || tag)
//   AAD     = "girru/v1/ntf\n" + from + "\n" + to + "\n" + ctr
//   sig     = ECDSA-P256-SHA256 over "girru/v1/ntf\n" + payload
//
// APNs carries it in the `g` key of the push payload with mutable-content set.

/// What the phone shows after decrypting.
public struct NoticeContent: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case approval
        /// Approve asks for Face ID / Touch ID in the app first.
        case approvalSensitive = "approval.sensitive"
        case taskFailed = "task.failed"
        case summary
        case security
    }

    public var kind: Kind
    public var title: String
    public var body: String
    /// Set for approvals; sent back in the signed Approve / Deny command.
    public var approvalId: String?
    /// Same value = one grouped thread ("3 tasks finished").
    public var group: String?

    public init(kind: Kind, title: String, body: String, approvalId: String? = nil, group: String? = nil) {
        self.kind = kind
        self.title = title
        self.body = body
        self.approvalId = approvalId
        self.group = group
    }

    public var isApproval: Bool { kind == .approval || kind == .approvalSensitive }
}

public enum Notice {
    public static let payloadKey = "g"
    /// APNs may deliver late; the replay window still makes each notice count once.
    public static let window: TimeInterval = 60 * 60

    private struct Payload: Codable { let from: String; let to: String; let ctr: UInt64; let ts: UInt64; let box: String }

    static func aad(from: String, to: String, ctr: UInt64) -> Data {
        Data("girru/v1/ntf\n\(from)\n\(to)\n\(ctr)".utf8)
    }

    /// The computer's side; here for tests and as the Swift reference.
    public static func seal(_ content: NoticeContent, computer: IdentitySigner, phoneId: String, counter: UInt64, notifyKey: Data, crypto: PairingCrypto, now: Date = Date()) throws -> String {
        let from = computer.deviceId
        let nonce = crypto.randomBytes(12)
        let box = try crypto.seal(try JSONEncoder().encode(content), key: notifyKey, nonce: nonce, aad: aad(from: from, to: phoneId, ctr: counter))
        let payload = try G1Text.encode(Payload(from: from, to: phoneId, ctr: counter, ts: G1Text.millis(now), box: Base64URL.encode(nonce + box)))
        let sig = try computer.sign(G1Text.signedBytes("ntf", payload))
        return "g1.ntf.\(payload).\(Base64URL.encode(sig))"
    }

    /// Signature, time and decryption are all checked before the replay window
    /// records the counter, so a forged notice never changes any state.
    public static func open(userInfo: [AnyHashable: Any], computer: PairedComputer, replay: inout ReplayWindow, crypto: PairingCrypto, now: Date = Date()) throws -> NoticeContent {
        guard let text = userInfo[payloadKey] as? String, text.utf8.count <= 3500 else { throw ProtocolError.badFormat }
        let (payload, s) = try G1Text.split(text, kind: "ntf")
        guard let sig = Base64URL.decode(s), crypto.verify(signature: sig, message: G1Text.signedBytes("ntf", payload), publicKeySPKI: computer.computerKey) else {
            throw ProtocolError.badSignature
        }
        let p = try G1Text.json(payload)
        guard p["from"] as? String == computer.computerId, p["to"] as? String == computer.phoneId else { throw ProtocolError.wrongTarget }
        let ctr = try G1Text.integer(p["ctr"])
        try G1Text.checkTime(try G1Text.integer(p["ts"]), now: now, window: Notice.window)
        guard let boxText = p["box"] as? String, let raw = Base64URL.decode(boxText), raw.count >= 12 + 16 else { throw ProtocolError.badFormat }
        // Decrypt before recording the counter, so a bad box cannot burn it.
        let plain = try crypto.open(raw.dropFirst(12), key: computer.notifyKey, nonce: raw.prefix(12), aad: aad(from: computer.computerId, to: computer.phoneId, ctr: ctr))
        guard let content = try? JSONDecoder().decode(NoticeContent.self, from: plain), isValid(content) else { throw ProtocolError.badFormat }
        guard replay.accept(ctr) else { throw ProtocolError.replay }
        return content
    }

    static func isValid(_ c: NoticeContent) -> Bool {
        func plain(_ s: String, max: Int) -> Bool {
            !s.isEmpty && s.count <= max && !s.unicodeScalars.contains { $0.value < 0x20 && $0 != "\n" }
        }
        guard plain(c.title, max: 120), plain(c.body, max: 600) else { return false }
        if c.isApproval {
            guard let id = c.approvalId, (1...64).contains(id.count),
                  id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return false }
        }
        return true
    }
}
