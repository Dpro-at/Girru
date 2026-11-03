import Foundation
import LocalAuthentication

/// Carries the pairing request to the computer and brings back its signed
/// welcome, over the local network or the relay. Built with the computer
/// connector (MOB-LINK-01); until then `UnavailablePairingTransport` is used.
protocol PairingTransport: Sendable {
    func send(request: String, to payload: PairingPayload) async throws
    /// Waits until the owner approves on the computer, or the QR code expires.
    func awaitWelcome(for payload: PairingPayload) async throws -> String
}

struct UnavailablePairingTransport: PairingTransport {
    struct NotBuilt: LocalizedError {
        var errorDescription: String? { "This version of Girru cannot reach your computer yet." }
    }
    func send(request: String, to payload: PairingPayload) async throws { throw NotBuilt() }
    func awaitWelcome(for payload: PairingPayload) async throws -> String { throw NotBuilt() }
}

/// Pairing steps 2–7 of PROTOCOL.md on the phone side. Runs only while the app
/// is unlocked, because creating and using the identity key needs the unlock.
@MainActor
final class PairingFlow: ObservableObject {
    enum Step: Equatable {
        case idle
        /// Shows the check code and the lifetime picker before sending.
        case confirm(checkCode: String, computerName: String?)
        case waitingForApproval(checkCode: String)
        case failed(String)
        case done
    }

    @Published private(set) var step: Step = .idle
    @Published var lifetime: PairingLifetime = .default

    private let transport: PairingTransport
    private let store: PairingStore
    private let crypto = CryptoKitPairingCrypto()
    private var payload: PairingPayload?
    private var signer: IdentitySigner?

    init(transport: PairingTransport = UnavailablePairingTransport(), store: PairingStore = PairingStore()) {
        self.transport = transport
        self.store = store
    }

    func reset() {
        payload = nil
        step = .idle
    }

    /// After the camera (or the bridge's qr.scan) read a code.
    func scanned(_ text: String, context: LAContext?) {
        guard let context else { step = .failed("Unlock Girru first."); return }
        do {
            let p = try PairingPayloadParser.parse(text, crypto: crypto)
            let s = try DeviceIdentity.loadOrCreate(context: context)
            payload = p
            signer = s
            let code = PairingMessages.checkCode(secret: p.pairingSecret, computerKey: p.computerKey, phoneKey: s.publicKeySPKI, crypto: crypto)
            step = .confirm(checkCode: code, computerName: p.computerName)
        } catch PairingPayloadError.expired {
            step = .failed("This code has expired. Show a new one on your computer.")
        } catch is PairingPayloadError {
            step = .failed("This is not a Girru pairing code.")
        } catch {
            step = .failed("This iPhone could not create its key. Try again.")
        }
    }

    /// The owner checked the codes match and picked a lifetime.
    func send(phoneName: String, pushToken: String?, onPaired: @escaping (PairedComputer) -> Void) {
        guard let p = payload, let s = signer, case .confirm(let code, _) = step else { return }
        step = .waitingForApproval(checkCode: code)
        let request = PairingRequest(key: Base64URL.encode(s.publicKeySPKI), name: String(phoneName.prefix(64)), platform: "ios",
                                     push: pushToken, lifetimeDays: lifetime.days)
        let transport = self.transport
        let crypto = self.crypto
        let store = self.store
        Task {
            do {
                // Signing needs the unlocked identity key, so it happens here, after the unlock.
                let sealed = try PairingMessages.sealRequest(request, signer: s, payload: p, crypto: crypto)
                try await transport.send(request: sealed, to: p)
                let welcomeText = try await transport.awaitWelcome(for: p)
                let w = try PairingMessages.openWelcome(welcomeText, payload: p, phoneId: s.deviceId, crypto: crypto)
                guard let notifyKey = Base64URL.decode(w.notifyKey), let granted = PairingLifetime(days: w.lifetimeDays) else {
                    throw ProtocolError.badFormat
                }
                // The computer's approval decides the lifetime, whatever was asked.
                let computer = PairedComputer(computerId: p.computerId, computerName: w.name ?? p.computerName, computerKey: p.computerKey,
                                              relay: p.relay, localAddresses: p.localAddresses,
                                              phoneId: s.deviceId, notifyKey: notifyKey, pairedAt: Date(), lifetime: granted)
                store.clear()
                try store.save(computer)
                self.payload = nil
                self.step = .done
                onPaired(computer)
            } catch let e as LocalizedError {
                self.step = .failed(e.errorDescription ?? "Pairing did not finish. Try again.")
            } catch {
                self.step = .failed("Pairing did not finish. Show a new code on your computer and try again.")
            }
        }
    }
}
