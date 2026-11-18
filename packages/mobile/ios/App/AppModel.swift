import Foundation
import LocalAuthentication

/// The computer's `reply` to one signed command (PROTOCOL.md "Inside a
/// session"). `data` is parsed JSON.
struct CommandReply: @unchecked Sendable {
    var ok: Bool
    var data: Any?
    var error: String?
}

/// Talks to the computer over the authenticated g1 session (MOB-LINK-01):
/// `SessionComputerLink`. `signer` proves this phone to the relay and signs
/// the session's hs1, so it comes from the unlocked identity key.
///
/// The link owns the session: every new session starts with a fresh
/// `Handshake.start` (the computer answers each hs1 once). Run frames end with
/// `run.end`; `RunEnd.reread` (`slow_link`) means read the rest with
/// `chat.messages`, `RunEnd.failed` is shown as a plain failure.
protocol ComputerLink: Sendable {
    /// Signs (with `sign`, right before sealing, so counters leave in order) and
    /// sends one command; `stream` gets an `api.stream`'s events.
    func call(signing sign: @escaping @Sendable () throws -> SignedCommand, to computer: PairedComputer, signer: IdentitySigner, stream: (@Sendable (StreamEvent) -> Void)?) async throws -> CommandReply
    /// Asks the computer whether this approval is still waiting for this phone.
    /// The answer comes over the session, so a forged push cannot fake it.
    func isPending(approvalId: String, on computer: PairedComputer, signer: IdentitySigner) async throws -> Bool
}

struct NotConnectedLink: ComputerLink {
    struct NotBuilt: LocalizedError {
        var errorDescription: String? { "Not sent: this version of Girru cannot reach your computer yet." }
    }
    func call(signing sign: @escaping @Sendable () throws -> SignedCommand, to computer: PairedComputer, signer: IdentitySigner, stream: (@Sendable (StreamEvent) -> Void)?) async throws -> CommandReply { throw NotBuilt() }
    func isPending(approvalId: String, on computer: PairedComputer, signer: IdentitySigner) async throws -> Bool { throw NotBuilt() }
}

/// The app is locked: nothing is signed or sent.
struct AppLocked: LocalizedError {
    var errorDescription: String? { "Unlock Girru first." }
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
    /// The full parameters of a cut-short approval, shown before Approve signs.
    @Published var fullView: ApprovalDetail?

    let lock = AppLock()
    let pairingFlow = PairingFlow()
    private let store = PairingStore()
    private let link: ComputerLink
    private let crypto = CryptoKitPairingCrypto()
    private var pendingDecision: (approvalId: String, approve: Bool, sensitive: Bool)?
    private static let installedKey = "installed"

    init(link: ComputerLink = SessionComputerLink(), defaults: UserDefaults = .standard) {
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

    /// The notification button opened the app. The button's own data is not
    /// trusted: only an id the extension recorded from a verified notice is
    /// acted on, and "sensitive" comes from that record. The decision is
    /// signed after the app lock (and a second check when sensitive).
    func queueDecision(approvalId: String, approve: Bool) {
        var verified = store.loadVerifiedApprovals()
        let entry = verified.take(approvalId)
        try? store.saveVerifiedApprovals(verified)
        guard let entry else {
            notice = "This request could not be checked. Open Approvals to answer it."
            return
        }
        pendingDecision = (approvalId, approve, entry.sensitive)
        if lock.isUnlocked { Task { await sendPendingDecision() } }
    }

    func sendPendingDecision() async {
        guard let d = pendingDecision, let computer, lock.isUnlocked, let context = lock.context else { return }
        pendingDecision = nil
        do {
            // Re-check with the computer before signing anything.
            let signer = try DeviceIdentity.loadOrCreate(context: context)
            guard try await link.isPending(approvalId: d.approvalId, on: computer, signer: signer) else {
                notice = "This request is no longer waiting."
                return
            }
            // The list gives the paramsHash the computer will check, and whether
            // the preview was cut short.
            let list = try await call(try CommandBody.approvalList(), computer: computer, context: context)
            guard list.ok else { notice = CommandFailure.message(for: list.error ?? "internal_error"); return }
            guard let summary = try ApprovalSummary.list(from: list.data).first(where: { $0.id == d.approvalId }) else {
                notice = "This request is no longer waiting."
                return
            }
            try await run(ApprovalFlow.start(summary, approve: d.approve), approve: d.approve, sensitive: d.sensitive, computer: computer)
        } catch let e as LocalizedError where e.errorDescription != nil {
            notice = e.errorDescription
        } catch {
            notice = "Could not send. Try again from Approvals."
        }
    }

    /// The owner read the full parameters and pressed Approve.
    func approveFullView() async {
        guard let detail = fullView, let computer else { return }
        fullView = nil
        do {
            try await run(.decide(body: try ApprovalFlow.approveBody(detail)), approve: true, sensitive: fullViewSensitive, computer: computer)
        } catch let e as LocalizedError where e.errorDescription != nil {
            notice = e.errorDescription
        } catch {
            notice = "Could not send. Try again from Approvals."
        }
    }

    func dismissFullView() {
        fullView = nil
        notice = "Not approved."
    }

    /// The kind recorded from the verified notice of the approval in `fullView`.
    private var fullViewSensitive = false

    /// Walks the approval steps: fetch the full view when the preview was cut
    /// short, show it, and sign approve only with the hash that was shown.
    private func run(_ first: ApprovalStep, approve: Bool, sensitive: Bool, computer: PairedComputer) async throws {
        var step = first
        while true {
            guard lock.isUnlocked, var context = lock.context else { return }
            switch step {
            case .fetchFullView(let body):
                let r = try await call(body, computer: computer, context: context)
                step = ApprovalFlow.afterDetail(ok: r.ok, data: r.data, error: r.error, askedId: detailId(body))
            case .showFullView(let detail):
                fullViewSensitive = sensitive
                fullView = detail
                return
            case .decideOnComputer(let message):
                notice = message
                return
            case .decide(let body):
                // A sensitive approval asks Face ID again right before the key signs.
                if sensitive && approve {
                    guard let fresh = await lock.confirmSensitive(reason: "Approve this request") else { notice = "Not approved."; return }
                    context = fresh
                }
                let r = try await call(body, computer: computer, context: context)
                if r.ok {
                    recordAuthenticatedUse()
                    notice = approve ? "Approved." : "Denied."
                } else {
                    notice = CommandFailure.message(for: r.error ?? "internal_error")
                }
                return
            }
        }
    }

    private func detailId(_ body: String) -> String {
        let obj = try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any]
        return obj?["id"] as? String ?? ""
    }

    /// Signs `body` behind the app lock and sends it. The id is inside the
    /// signed body; the computer's gate checks it is pending and was sent to
    /// this phone before acting.
    private func call(_ body: String, computer: PairedComputer, context: LAContext, stream: (@Sendable (StreamEvent) -> Void)? = nil) async throws -> CommandReply {
        let signer = try DeviceIdentity.loadOrCreate(context: context)
        let commandSigner = try CommandSigner(signer: signer, counter: MonotonicCounter(store: KeychainCounterStore()), crypto: crypto)
        let to = computer.computerId
        return try await link.call(signing: { try commandSigner.sign(body: body, to: to) }, to: computer, signer: signer, stream: stream)
    }

    // MARK: The app's own screens and the chat page

    /// Signs `body` behind the app lock and sends it. A refusal that ends the
    /// pairing ends it here; every accepted command renews the lifetime.
    func send(_ body: String, stream: (@Sendable (StreamEvent) -> Void)? = nil) async throws -> CommandReply {
        guard let computer else { throw LinkRefusal.unknownDevice }
        guard lock.isUnlocked, let context = lock.context else { throw AppLocked() }
        let r = try await call(body, computer: computer, context: context, stream: stream)
        if r.ok {
            recordAuthenticatedUse()
        } else {
            switch r.error {
            case "expired": computerRefused(.expired)
            case "revoked": computerRefused(.revoked)
            case "unknown_device": computerRefused(.unknownDevice)
            default: break
            }
        }
        return r
    }

    /// Approve or Deny on the Approvals screen: the same steps as a notification
    /// button (full view first when the preview was cut short), and Approve asks
    /// Face ID again right before the key signs.
    func decide(_ summary: ApprovalSummary, approve: Bool) async {
        guard let computer else { return }
        do {
            try await run(ApprovalFlow.start(summary, approve: approve), approve: approve, sensitive: true, computer: computer)
        } catch let e as LocalizedError where e.errorDescription != nil {
            notice = e.errorDescription
        } catch {
            notice = "Could not send. Try again."
        }
    }
}
