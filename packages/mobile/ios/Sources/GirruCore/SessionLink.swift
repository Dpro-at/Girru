import Foundation

/// The computer's answer to one signed command (PROTOCOL.md "Inside a session").
public struct LinkReply: @unchecked Sendable {
    public var ok: Bool
    /// Parsed JSON, when `ok`.
    public var data: Any?
    /// The refusal code, when not `ok` (see `CommandFailure.message(for:)`).
    public var error: String?
}

/// A `run` frame or the `run.end` that follows a started chat turn.
public enum RunEvent: @unchecked Sendable {
    case frame(runId: String, seq: UInt64, frame: [String: Any])
    case end(runId: String, end: RunEnd, code: String?)
}

/// The end-to-end session with the paired computer over the relay
/// (MOB-LINK-01): one relay connection that allows only the computer, a fresh
/// signed hs1 for every session (never resent), then sealed `g1.msg`
/// envelopes in both directions.
///
/// Replies are matched by `ref` (the command body's `ref`, else its nonce, which
/// is also what a command refused before its body was read comes back with).
/// Run frames for a `chat.send` go to the handler given with that command until
/// its `run.end`. A closed connection fails every waiting call; the next call
/// connects again with a new handshake.
public actor SessionLink {
    public let computerId: String
    private let computerKey: Data
    private let relay: String?
    private let urlSession: URLSession
    private let crypto: PairingCrypto
    private let timeout: TimeInterval

    private var client: RelayClient?
    private var session: Session?
    private var pump: Task<Void, Never>?
    private var replies: [String: CheckedContinuation<LinkReply, Error>] = [:]
    private var pendingQueries: [String: CheckedContinuation<Bool, Error>] = [:]
    private var runs: [String: @Sendable (RunEvent) -> Void] = [:]
    /// Envelopes go out in the order they were sealed: the computer refuses a
    /// `seq` that is not above the last one it took.
    private var sendChain: Task<Void, Never>?

    public init(computer: PairedComputer, urlSession: URLSession = .shared, crypto: PairingCrypto = CryptoKitPairingCrypto(), timeout: TimeInterval = 20) {
        computerId = computer.computerId
        computerKey = computer.computerKey
        relay = computer.relay
        self.urlSession = urlSession
        self.crypto = crypto
        self.timeout = timeout
    }

    public var isConnected: Bool { session != nil }

    /// Connects and runs the handshake when there is no live session. `signer`
    /// signs the relay hello and the hs1, so call it while the app is unlocked.
    public func connect(signer: IdentitySigner) async throws {
        if session != nil, let client, await client.isOpen { return }
        await drop(RelayError.closed)
        guard let relay else { throw PairingLinkError.noRelay }
        let c = RelayClient(relay: relay, session: urlSession)
        try await c.connect(signer: signer, allow: [computerId])
        let pending = try Handshake.start(signer: signer, peerId: computerId, crypto: crypto)
        do {
            try await c.send(to: computerId, env: pending.hello)
            let computer = computerId
            let frame = try await c.next(timeout: timeout) { f in
                guard let m = RelayFrames.message(f) else { return false }
                return m.from == computer && m.env.hasPrefix("g1.hs2.")
            }
            guard let reply = RelayFrames.message(frame)?.env else { throw ProtocolError.badFormat }
            session = try Handshake.finish(pending, peerSPKI: computerKey, reply: reply, crypto: crypto)
        } catch {
            await c.close()
            throw error
        }
        client = c
        pump = Task { [weak self] in await self?.receive(from: c) }
    }

    /// Sends one signed command and returns its reply. `runs` gets the `run`
    /// frames and the `run.end` of a started chat turn.
    public func call(_ command: SignedCommand, runs handler: (@Sendable (RunEvent) -> Void)? = nil) async throws -> LinkReply {
        let ref = Self.ref(of: command)
        let plaintext = try JSONEncoder().encode(command)
        return try await withCheckedThrowingContinuation { c in
            replies[ref] = c
            if let handler { runs[ref] = handler }
            do {
                try sealAndSend(plaintext)
            } catch {
                replies[ref] = nil
                runs[ref] = nil
                c.resume(throwing: error)
                return
            }
            expire(ref)
        }
    }

    /// The unsigned `approval.pending {id}` query: a hint for the screen, the
    /// computer checks again when the signed decision arrives.
    public func isPending(approvalId: String) async throws -> Bool {
        let body = Data(try CommandBody.approvalPendingQuery(id: approvalId).utf8)
        return try await withCheckedThrowingContinuation { c in
            pendingQueries[approvalId] = c
            do {
                try sealAndSend(body)
            } catch {
                pendingQueries[approvalId] = nil
                c.resume(throwing: error)
                return
            }
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64((self?.timeout ?? 20) * 1_000_000_000))
                await self?.timeOutQuery(approvalId)
            }
        }
    }

    public func close() async {
        await drop(RelayError.closed)
    }

    // MARK: inside

    static func ref(of command: SignedCommand) -> String {
        if let obj = try? JSONSerialization.jsonObject(with: Data(command.body.utf8)) as? [String: Any], let ref = obj["ref"] as? String, CommandBody.isValidRef(ref) {
            return ref
        }
        return command.nonce
    }

    private func sealAndSend(_ plaintext: Data) throws {
        guard var s = session, let client else { throw RelayError.closed }
        let env = try s.seal(plaintext, crypto: crypto)
        session = s
        let previous = sendChain
        let to = computerId
        sendChain = Task {
            await previous?.value
            try? await client.send(to: to, env: env)
        }
    }

    private func expire(_ ref: String) {
        Task { [weak self, timeout] in
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            await self?.timeOutReply(ref)
        }
    }

    private func timeOutReply(_ ref: String) {
        replies.removeValue(forKey: ref)?.resume(throwing: RelayError.timedOut)
    }

    private func timeOutQuery(_ id: String) {
        pendingQueries.removeValue(forKey: id)?.resume(throwing: RelayError.timedOut)
    }

    private func receive(from c: RelayClient) async {
        let computer = computerId
        while true {
            do {
                let frame = try await c.next(timeout: nil) { f in
                    guard let m = RelayFrames.message(f) else { return false }
                    return m.from == computer && m.env.hasPrefix("g1.msg.")
                }
                guard let env = RelayFrames.message(frame)?.env else { continue }
                handle(env)
            } catch RelayError.offline {
                // The computer went off the relay: what is waiting fails, the link stays for a retry.
                failWaiting(RelayError.offline)
            } catch {
                await drop(error)
                return
            }
        }
    }

    private func handle(_ env: String) {
        guard var s = session else { return }
        // A broken, replayed or foreign envelope changes nothing and is dropped.
        guard let plaintext = try? s.open(env, crypto: crypto), let message = try? ComputerMessage.parse(plaintext) else { return }
        session = s
        switch message {
        case let .reply(ref, ok, data, error):
            guard let ref, let c = replies.removeValue(forKey: ref) else { return }
            // A turn that did not start sends no run frames.
            if !ok { runs[ref] = nil }
            c.resume(returning: LinkReply(ok: ok, data: data, error: error))
        case let .run(ref, runId, seq, frame):
            if let ref { runs[ref]?(.frame(runId: runId, seq: seq, frame: frame)) }
        case let .runEnd(ref, runId, end, code):
            if let ref { runs.removeValue(forKey: ref)?(.end(runId: runId, end: end, code: code)) }
        case let .approvalPending(id, pending):
            pendingQueries.removeValue(forKey: id)?.resume(returning: pending)
        }
    }

    private func failWaiting(_ error: Error) {
        let r = replies, q = pendingQueries
        replies.removeAll()
        pendingQueries.removeAll()
        runs.removeAll()
        for c in r.values { c.resume(throwing: error) }
        for c in q.values { c.resume(throwing: error) }
    }

    private func drop(_ error: Error) async {
        pump?.cancel()
        pump = nil
        sendChain = nil
        session = nil
        let c = client
        client = nil
        failWaiting(error)
        await c?.close()
    }
}
