import Foundation

/// The relay frames of PROTOCOL.md › Relay wire protocol, phone side. Pure, so
/// the hello rules are checked without a network.
public enum RelayFrames {
    public static let version = 1

    /// The signed `hello` for one relay `challenge`. Refused when the challenge
    /// names any relay but `configured` (byte for byte), or its nonce is not 32
    /// bytes: a hello is good for one relay and one connection only.
    public static func hello(challenge: [String: Any], configured: String, signer: IdentitySigner, allow: [String]) throws -> [String: Any] {
        guard challenge["t"] as? String == "challenge", challenge["v"] as? Int == version,
              let relay = challenge["relay"] as? String, let nonce = challenge["nonce"] as? String, Base64URL.isId(nonce)
        else { throw ProtocolError.badFormat }
        guard RelayName.challengeMatches(relay, configured: configured) else { throw RelayError.wrongRelay }
        let sig = try signer.sign(Data("girru/relay/v1/hello\n\(configured)\n\(nonce)".utf8))
        return ["t": "hello", "v": version, "key": Base64URL.encode(signer.publicKeySPKI), "sig": Base64URL.encode(sig), "allow": allow, "pairing": [String]()]
    }

    public static func send(to: String, env: String) -> [String: Any] { ["t": "send", "to": to, "env": env] }

    public static func send(pairing: String, env: String) -> [String: Any] { ["t": "send", "pairing": pairing, "env": env] }

    /// A `msg` frame's sender and envelope, or nil for any other frame.
    public static func message(_ frame: [String: Any]) -> (from: String, env: String)? {
        guard frame["t"] as? String == "msg", let from = frame["from"] as? String, let env = frame["env"] as? String else { return nil }
        return (from, env)
    }
}

public enum RelayError: LocalizedError, Equatable {
    /// The relay's challenge named another relay than the one in the QR code.
    case wrongRelay
    /// The relay answered the hello with another id than this phone's key.
    case wrongId
    /// No `ready` (or no frame asked for) in time.
    case timedOut
    /// The connection closed, or could not open.
    case closed
    /// `drop` with `offline`: the computer is not connected, or does not allow this phone.
    case offline
    /// The relay refused a frame (`rate_limited`, `too_large`, `bad_frame`).
    case refused(String)

    public var errorDescription: String? {
        switch self {
        case .wrongRelay: "The relay is not the one your computer named. Pairing stopped."
        case .wrongId: "The relay did not accept this iPhone's key."
        case .timedOut: "Your computer did not answer in time. Check it is on and online, then try again."
        case .closed: "Girru cannot reach the relay. Check your internet connection and try again."
        case .offline: "Your computer is not reachable right now. Check Girru is open on it, then try again."
        case .refused: "The relay refused the message. Try again."
        }
    }
}

/// One live connection to a relay: challenge → signed hello → ready, then
/// `send` and `msg` frames. Frames that nobody waits for yet are kept in an
/// inbox, so a reply that arrives before its waiter is never lost.
///
/// The relay name must be exactly the QR code's `relay` (`wss://` only, see
/// RelayName); the URL dialled is that name. Tests pass their own URLSession to
/// trust a local test certificate; the app uses the shared default.
public actor RelayClient {
    public let relay: String
    public private(set) var deviceId: String?
    public var isOpen: Bool { task != nil && closedError == nil }

    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var inbox: [[String: Any]] = []
    private var waiters: [(id: UUID, match: @Sendable ([String: Any]) -> Bool, continuation: CheckedContinuation<[String: Any], Error>)] = []
    private var closedError: RelayError?

    public init(relay: String, session: URLSession = .shared) {
        self.relay = relay
        self.session = session
    }

    /// Opens the connection and proves this phone's id with a hello that lets
    /// only `allow` send to it. Returns the proven device id.
    @discardableResult
    public func connect(signer: IdentitySigner, allow: [String], timeout: TimeInterval = 10) async throws -> String {
        guard RelayName.isValid(relay), let url = URL(string: relay) else { throw RelayError.wrongRelay }
        let task = session.webSocketTask(with: url)
        // A 1 MiB envelope plus its frame.
        task.maximumMessageSize = (1 << 20) + 4096
        self.task = task
        task.resume()
        receiveLoop(task)
        do {
            let challenge = try await next(timeout: timeout) { $0["t"] as? String == "challenge" }
            try send(RelayFrames.hello(challenge: challenge, configured: relay, signer: signer, allow: allow))
            let ready = try await next(timeout: timeout) { $0["t"] as? String == "ready" }
            guard let id = ready["id"] as? String, id == signer.deviceId else { throw RelayError.wrongId }
            deviceId = id
            return id
        } catch {
            close()
            throw error
        }
    }

    public func send(to: String, env: String) throws { try send(RelayFrames.send(to: to, env: env)) }

    public func send(pairing: String, env: String) throws { try send(RelayFrames.send(pairing: pairing, env: env)) }

    /// The next frame that `match` takes, waiting until `timeout` (nil: no limit,
    /// only a closed connection ends the wait). A `drop` with `offline` and a
    /// relay `error` end the wait as errors: they answer what this phone sent.
    public func next(timeout: TimeInterval?, _ match: @escaping @Sendable ([String: Any]) -> Bool) async throws -> [String: Any] {
        if let i = inbox.firstIndex(where: { match($0) || Self.isFailure($0) }) {
            return try Self.result(inbox.remove(at: i))
        }
        if let closedError { throw closedError }
        let id = UUID()
        let frame: [String: Any] = try await withCheckedThrowingContinuation { c in
            waiters.append((id, { match($0) || Self.isFailure($0) }, c))
            if let timeout {
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                    await self?.expire(id)
                }
            }
        }
        return try Self.result(frame)
    }

    public func close() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        finish(.closed)
    }

    // MARK: inside

    private static func isFailure(_ f: [String: Any]) -> Bool {
        let t = f["t"] as? String
        return t == "error" || (t == "drop" && f["reason"] as? String == "offline")
    }

    private static func result(_ f: [String: Any]) throws -> [String: Any] {
        switch f["t"] as? String {
        case "error": throw RelayError.refused(f["code"] as? String ?? "bad_frame")
        case "drop" where f["reason"] as? String == "offline": throw RelayError.offline
        default: return f
        }
    }

    private func send(_ frame: [String: Any]) throws {
        guard let task, closedError == nil else { throw closedError ?? RelayError.closed }
        let data = try JSONSerialization.data(withJSONObject: frame)
        task.send(.string(String(decoding: data, as: UTF8.self))) { [weak self] error in
            if error != nil { Task { await self?.finish(.closed) } }
        }
    }

    private nonisolated func receiveLoop(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(.string(let text)):
                Task { await self.deliver(text) }
                self.receiveLoop(task)
            case .success:
                // The relay sends text frames only; anything else ends the link.
                Task { await self.close() }
            case .failure:
                Task { await self.finish(.closed) }
            }
        }
    }

    private func deliver(_ text: String) {
        guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)), let frame = object as? [String: Any] else { return }
        if let i = waiters.firstIndex(where: { $0.match(frame) }) {
            waiters.remove(at: i).continuation.resume(returning: frame)
        } else {
            inbox.append(frame)
        }
    }

    private func expire(_ id: UUID) {
        guard let i = waiters.firstIndex(where: { $0.id == id }) else { return }
        waiters.remove(at: i).continuation.resume(throwing: RelayError.timedOut)
    }

    private func finish(_ error: RelayError) {
        if closedError == nil { closedError = error }
        let pending = waiters
        waiters.removeAll()
        for w in pending { w.continuation.resume(throwing: error) }
    }
}
