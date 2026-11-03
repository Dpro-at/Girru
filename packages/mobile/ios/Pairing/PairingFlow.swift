import Foundation
import LocalAuthentication

/// Carries the pairing messages between the phone and the computer, over the
/// local network or the relay. Built with the computer connector
/// (MOB-LINK-01); until then `UnavailablePairingTransport` is used.
protocol PairingTransport: Sendable {
    /// Sends the sealed `g1.preq`. A retry sends the same text again; the
    /// computer answers it with the same challenge.
    func send(request: String, to payload: PairingPayload) async throws
    /// The computer's `g1.pchal` for this phone, or nil when none came by
    /// `deadline` (the QR code's `exp`).
    func awaitChallenge(for payload: PairingPayload, until deadline: Date) async throws -> String?
    /// Waits until the owner approves on the computer. No deadline: once the
    /// challenge came, the computer finishes this pairing even after its code
    /// renewed.
    func awaitWelcome(for payload: PairingPayload) async throws -> String
}

struct UnavailablePairingTransport: PairingTransport {
    struct NotBuilt: LocalizedError {
        var errorDescription: String? { "This version of Girru cannot reach your computer yet." }
    }
    func send(request: String, to payload: PairingPayload) async throws { throw NotBuilt() }
    func awaitChallenge(for payload: PairingPayload, until deadline: Date) async throws -> String? { throw NotBuilt() }
    func awaitWelcome(for payload: PairingPayload) async throws -> String { throw NotBuilt() }
}

/// Pairing steps 2–7 of PROTOCOL.md on the phone side. Runs only while the app
/// is unlocked, because creating and using the identity key needs the unlock.
/// The rules (one request resent unchanged, no code before the challenge, no
/// welcome before the code, expiry) live in `PairingProgress`.
@MainActor
final class PairingFlow: ObservableObject {
    enum Step: Equatable {
        case idle
        /// The lifetime picker, before the request goes out.
        case choose(computerName: String?)
        /// Request sent; no code until the computer's challenge arrives.
        case waitingForCode
        /// Shows the check code; the owner compares it and approves on the computer.
        case waitingForApproval(checkCode: String)
        case failed(String)
        case done
    }

    @Published private(set) var step: Step = .idle
    @Published var lifetime: PairingLifetime = .default

    private let transport: PairingTransport
    private let store: PairingStore
    private let crypto = CryptoKitPairingCrypto()
    private var progress: PairingProgress?
    private var signer: IdentitySigner?
    private var task: Task<Void, Never>?

    init(transport: PairingTransport = UnavailablePairingTransport(), store: PairingStore = PairingStore()) {
        self.transport = transport
        self.store = store
    }

    func reset() {
        task?.cancel()
        task = nil
        progress = nil
        signer = nil
        step = .idle
    }

    /// After the camera (or the bridge's qr.scan) read a code.
    func scanned(_ text: String, context: LAContext?) {
        guard let context else { step = .failed("Unlock Girru first."); return }
        do {
            let p = try PairingPayloadParser.parse(text, crypto: crypto)
            let s = try DeviceIdentity.loadOrCreate(context: context)
            progress = PairingProgress(payload: p, phoneKey: s.publicKeySPKI)
            signer = s
            step = .choose(computerName: p.computerName)
        } catch PairingPayloadError.expired {
            step = .failed(PairingProgress.expiredMessage)
        } catch is PairingPayloadError {
            step = .failed("This is not a Girru pairing code.")
        } catch let e as LocalizedError where e.errorDescription != nil {
            step = .failed(e.errorDescription!)
        } catch {
            step = .failed("This iPhone could not create its key. Try again.")
        }
    }

    /// The owner picked a lifetime: send the request, wait for the challenge,
    /// show the code, wait for the welcome.
    func send(phoneName: String, pushToken: String?, onPaired: @escaping (PairedComputer) -> Void) {
        guard let start = progress, let s = signer, case .choose = step else { return }
        guard start.isCurrent() else { step = .failed(PairingProgress.expiredMessage); return }
        step = .waitingForCode
        let request = PairingRequest(key: Base64URL.encode(s.publicKeySPKI), name: String(phoneName.prefix(64)), platform: "ios",
                                     push: pushToken, lifetimeDays: lifetime.days)
        let transport = self.transport
        let crypto = self.crypto
        let store = self.store
        task = Task {
            var progress = start
            do {
                // Signing needs the unlocked identity key, so it happens here, after the unlock.
                let sealed = try progress.requestText(request, signer: s, crypto: crypto)
                let p = progress.payload
                try await transport.send(request: sealed, to: p)
                guard let challengeText = try await transport.awaitChallenge(for: p, until: p.expiresAt) else { throw ProtocolError.expired }
                let code = try progress.receiveChallenge(challengeText, crypto: crypto)
                self.progress = progress
                self.step = .waitingForApproval(checkCode: code)
                let welcomeText = try await transport.awaitWelcome(for: p)
                let w = try progress.receiveWelcome(welcomeText, phone: s, crypto: crypto)
                guard let notifyKey = Base64URL.decode(w.notifyKey), let granted = PairingLifetime(days: w.lifetimeDays) else {
                    throw ProtocolError.badFormat
                }
                // The computer's approval decides the lifetime, whatever was asked.
                let computer = PairedComputer(computerId: p.computerId, computerName: w.name ?? p.computerName, computerKey: p.computerKey,
                                              relay: p.relay, localAddresses: p.localAddresses,
                                              phoneId: progress.phoneId, notifyKey: notifyKey, pairedAt: Date(), lifetime: granted)
                guard !Task.isCancelled else { return }
                store.clear()
                try store.save(computer)
                self.progress = nil
                self.step = .done
                onPaired(computer)
            } catch is CancellationError {
                return
            } catch ProtocolError.expired {
                self.step = .failed(PairingProgress.expiredMessage)
            } catch let e as LocalizedError where e.errorDescription != nil {
                self.step = .failed(e.errorDescription!)
            } catch {
                self.step = .failed("Pairing did not finish. Show a new code on your computer and try again.")
            }
        }
    }
}
