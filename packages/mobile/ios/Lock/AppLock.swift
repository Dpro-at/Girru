import Foundation
import LocalAuthentication

/// The required app lock. Locked on every launch and after `LockPolicy`'s delay
/// in the background; there is no setting that turns it off.
@MainActor
final class AppLock: ObservableObject {
    enum State: Equatable {
        case locked
        case unlocking
        case unlocked
        /// The phone has no passcode, so nothing can protect the keys.
        case needsPasscode
    }

    @Published private(set) var state: State = .locked
    @Published private(set) var policy: LockPolicy
    @Published private(set) var lastError: String?

    /// The evaluated context of the current unlock. Keychain and Secure Enclave
    /// reads use it, so one unlock covers them until the next lock.
    private(set) var context: LAContext?
    private var backgroundedAt: Date?
    private let defaults: UserDefaults
    private static let policyKey = "lockPolicy"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // The policy holds only a delay, clamped on read, so UserDefaults is fine.
        if let data = defaults.data(forKey: Self.policyKey), let p = try? JSONDecoder().decode(LockPolicy.self, from: data) {
            policy = p
        } else {
            policy = LockPolicy()
        }
    }

    var isUnlocked: Bool { state == .unlocked }

    /// What the device offers, for the button title ("Unlock with Face ID").
    var biometryName: String {
        let c = LAContext()
        _ = c.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch c.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return "passcode"
        }
    }

    func setRelockDelay(_ delay: TimeInterval) {
        guard policy.setRelockDelay(delay), let data = try? JSONEncoder().encode(policy) else { return }
        defaults.set(data, forKey: Self.policyKey)
    }

    /// Face ID / Touch ID with the phone passcode as fallback.
    func unlock() async {
        guard state == .locked || state == .needsPasscode else { return }
        let c = LAContext()
        c.localizedFallbackTitle = "Use passcode"
        var error: NSError?
        guard c.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            state = (error?.code == LAError.passcodeNotSet.rawValue) ? .needsPasscode : .locked
            lastError = state == .needsPasscode ? nil : "This iPhone cannot check who you are right now."
            return
        }
        state = .unlocking
        do {
            let ok = try await c.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Girru")
            if ok {
                context = c
                lastError = nil
                state = .unlocked
            } else {
                state = .locked
            }
        } catch {
            // Cancel and failure both leave the app locked; the button stays.
            state = .locked
        }
    }

    /// Asks again even while unlocked, for terminal and high-risk approvals.
    /// Returns a fresh context to sign with.
    func confirmSensitive(reason: String) async -> LAContext? {
        guard state == .unlocked else { return nil }
        let c = LAContext()
        // No reuse of an earlier Face ID match: this must be a new check.
        c.touchIDAuthenticationAllowableReuseDuration = 0
        do {
            return try await c.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) ? c : nil
        } catch {
            return nil
        }
    }

    func lock() {
        context?.invalidate()
        context = nil
        state = .locked
    }

    // Scene phase hooks.

    func didEnterBackground(now: Date = Date()) {
        backgroundedAt = now
        // A zero delay locks at once, so the next open never shows content.
        if policy.relockDelay == 0 { lock() }
    }

    /// Only a real trip to the background counts; pulling down Control Center
    /// makes the scene inactive without backgrounding it.
    func willEnterForeground(now: Date = Date()) {
        guard let since = backgroundedAt else { return }
        if state == .unlocked, policy.shouldLock(backgroundedAt: since, now: now) { lock() }
        backgroundedAt = nil
    }
}
