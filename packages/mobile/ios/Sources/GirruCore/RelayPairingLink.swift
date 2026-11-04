import Foundation

/// Pairing steps 3–6 of PROTOCOL.md over the relay: one connection that lists
/// only the computer (`cid`) on its allow list, sends the sealed `g1.preq` to
/// the pairing id, then takes the computer's `g1.pchal` and `g1.pwel`, which
/// come back to this phone's device id by the same path.
///
/// It only carries text: opening and checking the challenge and the welcome is
/// `PairingProgress`'s job. Frames from anyone but the computer are ignored
/// (the relay's allow list already stops them).
public actor RelayPairingLink {
    private let session: URLSession
    private var client: RelayClient?
    /// The pairing id `client` was opened for: a retry of that request reuses
    /// it, any other pairing starts a fresh connection.
    private var pairingId: String?

    public init(session: URLSession = .shared) {
        self.session = session
    }

    /// Connects (once per pairing id) and sends the request. A retry sends the
    /// same text again.
    public func send(request: String, to payload: PairingPayload, signer: IdentitySigner) async throws {
        guard let relay = payload.relay else {
            // The "Only on this Wi-Fi" path is not built in the apps yet.
            throw PairingLinkError.noRelay
        }
        let client = try await connected(relay: relay, payload: payload, signer: signer)
        try await client.send(pairing: payload.pairingId, env: request)
    }

    /// The computer's `g1.pchal`, or nil when none came by `deadline`.
    public func awaitChallenge(for payload: PairingPayload, until deadline: Date) async throws -> String? {
        guard let client else { throw RelayError.closed }
        let wait = deadline.timeIntervalSinceNow
        guard wait > 0 else { return nil }
        do {
            return try await Self.envelope(client, from: payload.computerId, prefix: "g1.pchal.", timeout: wait)
        } catch RelayError.timedOut {
            return nil
        }
    }

    /// The computer's `g1.pwel`, once the owner chose Allow. No deadline; the
    /// connection is closed after it, since pairing is over.
    public func awaitWelcome(for payload: PairingPayload) async throws -> String {
        guard let client else { throw RelayError.closed }
        defer { Task { await self.close() } }
        return try await Self.envelope(client, from: payload.computerId, prefix: "g1.pwel.", timeout: nil)
    }

    public func close() async {
        await client?.close()
        client = nil
        pairingId = nil
    }

    private func connected(relay: String, payload: PairingPayload, signer: IdentitySigner) async throws -> RelayClient {
        if let client, pairingId == payload.pairingId, await client.isOpen { return client }
        await close()
        let c = RelayClient(relay: relay, session: session)
        try await c.connect(signer: signer, allow: [payload.computerId])
        client = c
        pairingId = payload.pairingId
        return c
    }

    private static func envelope(_ client: RelayClient, from computer: String, prefix: String, timeout: TimeInterval?) async throws -> String {
        let frame = try await client.next(timeout: timeout) { f in
            guard let m = RelayFrames.message(f) else { return false }
            return m.from == computer && m.env.hasPrefix(prefix)
        }
        guard let m = RelayFrames.message(frame) else { throw ProtocolError.badFormat }
        return m.env
    }
}

public enum PairingLinkError: LocalizedError, Equatable {
    case noRelay

    public var errorDescription: String? {
        "This code is for pairing on the same Wi-Fi only, which this version of Girru cannot do yet."
    }
}
