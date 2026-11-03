import Foundation

/// A command from this phone to its computer, PROTOCOL.md "Signed commands".
/// Signed by the phone's identity key on top of the session encryption.
public struct SignedCommand: Codable, Equatable, Sendable {
    public let device: String
    public let to: String
    public let ctr: UInt64
    public let ts: UInt64
    public let nonce: String
    public let body: String
    public let sig: String

    static func signedText(device: String, to: String, ctr: UInt64, ts: UInt64, nonce: String, body: String, crypto: PairingCrypto) -> Data {
        let bodyHash = Base64URL.encode(crypto.sha256(Data(body.utf8)))
        return Data("girru/v1/cmd\n\(device)\n\(to)\n\(ctr)\n\(ts)\n\(nonce)\n\(bodyHash)".utf8)
    }
}

/// Our own outgoing counter. The computer refuses any counter not above the last
/// one it accepted, so the value is saved before it is used: a crash can skip
/// a number but never reuse one.
public protocol CounterStore: AnyObject {
    func load() -> UInt64
    func save(_ value: UInt64) throws
}

public final class InMemoryCounterStore: CounterStore {
    private var value: UInt64
    public init(start: UInt64 = 0) { value = start }
    public func load() -> UInt64 { value }
    public func save(_ value: UInt64) throws { self.value = value }
}

public final class MonotonicCounter {
    private let store: CounterStore
    private let lock = NSLock()

    public init(store: CounterStore) { self.store = store }

    public func next() throws -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        let value = store.load() + 1
        guard value <= maxSafeInteger else { throw ProtocolError.counterExhausted }
        try store.save(value)
        return value
    }
}

public struct CommandSigner {
    public let signer: IdentitySigner
    public let counter: MonotonicCounter
    public let crypto: PairingCrypto

    public init(signer: IdentitySigner, counter: MonotonicCounter, crypto: PairingCrypto) {
        self.signer = signer
        self.counter = counter
        self.crypto = crypto
    }

    /// `to` = the computer's device id, so a command cannot be replayed to another computer.
    public func sign(body: String, to computerId: String, now: Date = Date()) throws -> SignedCommand {
        guard Base64URL.isId(computerId) else { throw ProtocolError.badFormat }
        guard body.utf8.count <= 512 * 1024 else { throw ProtocolError.tooLarge }
        let device = signer.deviceId
        let ctr = try counter.next()
        let ts = G1Text.millis(now)
        let nonce = Base64URL.encode(crypto.randomBytes(16))
        let text = SignedCommand.signedText(device: device, to: computerId, ctr: ctr, ts: ts, nonce: nonce, body: body, crypto: crypto)
        let sig = Base64URL.encode(try signer.sign(text))
        return SignedCommand(device: device, to: computerId, ctr: ctr, ts: ts, nonce: nonce, body: body, sig: sig)
    }

    /// Checks a command against the rules the computer applies (minus pairing
    /// state). For tests; the computer's gate is the authority.
    public static func check(_ c: SignedCommand, publicKeySPKI: Data, selfId: String, lastCounter: UInt64, crypto: PairingCrypto, now: Date = Date()) throws {
        guard c.nonce.count == 22, Base64URL.decode(c.nonce)?.count == 16, c.ctr >= 1 else { throw ProtocolError.badFormat }
        guard DeviceId.of(spki: publicKeySPKI) == c.device else { throw ProtocolError.wrongKey }
        guard c.to == selfId else { throw ProtocolError.wrongTarget }
        let text = SignedCommand.signedText(device: c.device, to: c.to, ctr: c.ctr, ts: c.ts, nonce: c.nonce, body: c.body, crypto: crypto)
        guard let sig = Base64URL.decode(c.sig), crypto.verify(signature: sig, message: text, publicKeySPKI: publicKeySPKI) else {
            throw ProtocolError.badSignature
        }
        try G1Text.checkTime(c.ts, now: now, window: protocolWindow)
        guard c.ctr > lastCounter else { throw ProtocolError.replay }
    }
}
