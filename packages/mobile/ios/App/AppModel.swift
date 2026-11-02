import Foundation
import LocalAuthentication

/// Sends signed commands to the computer. Built with MOB-LINK-01; until then
/// commands wait in the outbox and the app says so.
protocol ComputerLink: Sendable {
    func send(_ command: SignedCommand, to computer: PairedComputer) async throws
}

struct NotConnectedLink: ComputerLink {
    struct NotBuilt: LocalizedError {
        var errorDescription: String? { "Not sent: this version of Girru cannot reach your computer yet." }
    }
    func send(_ command: SignedCommand, to computer: PairedComputer) async throws { throw NotBuilt() }
}

/// What the computer can answer that ends a pairing.
enum LinkRefusal: Error {
    case expired
    case revoked
    case unknownDevice
}

/// App-wide state after the lock: which computer, if any, and its lifetime.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var pairing: PairingState
    @Published var notice: String?

    let lock = AppLock()
    let pairingFlow = PairingFlow()
    private let store = PairingStore()
    private let link: ComputerLink
    private let crypto = CryptoKitPairingCrypto()
    private var pendingDecision: (approvalId: String, approve: Bool, sensitive: Bool)?
    private static let installedKey = "installed"

    init(link: ComputerLink = NotConnectedLink(), defaults: UserDefaults = .standard) {
        self.link = link
        // Keychain items outlive an uninstall, UserDefaults does not. A missing
        // flag means a fresh install: drop any old keys so uninstalling really
        // ends the pairing (PROTOCOL.md "Device identity keys").
        if !defaults.bool(forKey: Self.installedKey) {
            PairingStore().clear()
            DeviceIdentity.destroy()
            KeychainStore.shared.delete(account: "push-token")
            defaults.set(true, forKey: Self.installedKey)
        }
        pairing = PairingState.evaluate(PairingStore().load())
        if case .ended = pairing { PairingStore().clear() }
    }

    var computer: PairedComputer? {
        if case .paired(let c) = pairing { return c }
        return nil
    }

    func didPair(_ computer: PairedComputer) {
        pairing = .paired(computer)
    }

    /// Re-checks the sliding expiry, e.g. when returning to the foreground.
    func refreshPairing() {
        let state = PairingState.evaluate(store.load())
        if case .ended = state { store.clear() }
        pairing = state
    }

    /// Call after an authenticated exchange with the computer (accepted command
    /// or finished handshake): renews the sliding lifetime.
    func recordAuthenticatedUse(now: Date = Date()) {
        guard var c = computer else { return }
        if c.renew(at: now) {
            try? store.save(c)
            pairing = .paired(c)
        } else {
            end(.expired)
        }
    }

    /// The computer is the authority: when it refuses this phone, forget the
    /// pairing and show the pairing screen with a short reason.
    func computerRefused(_ refusal: LinkRefusal) {
        switch refusal {
        case .expired: end(.expired)
        case .revoked: end(.revoked)
        case .unknownDevice: end(.refusedByComputer)
        }
    }

    /// "Remove this phone" from the phone: keys and pairing are deleted.
    func unpairThisPhone() {
        store.clear()
        DeviceIdentity.destroy()
        pairing = .notPaired
    }

    private func end(_ reason: PairingEndReason) {
        store.clear()
        pairing = .ended(reason)
    }

    // MARK: Approvals from notification buttons

    /// The notification button opened the app; the decision is signed after the
    /// app lock (and, for sensitive approvals, a second check).
    func queueDecision(approvalId: String, approve: Bool, sensitive: Bool) {
        pendingDecision = (approvalId, approve, sensitive)
        if lock.isUnlocked { Task { await sendPendingDecision() } }
    }

    func sendPendingDecision() async {
        guard let d = pendingDecision, let computer, lock.isUnlocked else { return }
        pendingDecision = nil
        var context = lock.context
        if d.sensitive && d.approve {
            context = await lock.confirmSensitive(reason: "Approve this request")
            guard context != nil else { notice = "Not approved."; return }
        }
        guard let context else { return }
        do {
            let signer = try DeviceIdentity.loadOrCreate(context: context)
            let body = try String(decoding: JSONSerialization.data(withJSONObject: [
                "type": "approval.decide", "id": d.approvalId, "approve": d.approve,
            ], options: [.sortedKeys]), as: UTF8.self)
            let command = try CommandSigner(signer: signer, counter: MonotonicCounter(store: KeychainCounterStore()), crypto: crypto)
                .sign(body: body, to: computer.computerId)
            try await link.send(command, to: computer)
            notice = d.approve ? "Approved." : "Denied."
        } catch let e as LocalizedError {
            notice = e.errorDescription
        } catch {
            notice = "Could not send. Try again from Approvals."
        }
    }
}
