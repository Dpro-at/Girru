import UIKit
import UserNotifications

/// APNs registration. The token goes to the computer inside the encrypted
/// pairing request; the relay only sees it when the computer asks it to send.
@MainActor
final class PushRegistrar: ObservableObject {
    @Published private(set) var token: String?
    @Published private(set) var status: String = "unknown"

    private let keychain = KeychainStore.shared
    private static let account = "push-token"

    init() {
        if let data = try? keychain.get(account: Self.account) { token = String(data: data, encoding: .utf8) }
    }

    /// Reads the current setting; with `ask`, shows the system prompt first.
    @discardableResult
    func refresh(ask: Bool) async -> String {
        let center = UNUserNotificationCenter.current()
        var settings = await center.notificationSettings()
        if ask && settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
            settings = await center.notificationSettings()
        }
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            status = "granted"
            UIApplication.shared.registerForRemoteNotifications()
        case .denied:
            status = "denied"
        default:
            status = "not-asked"
        }
        return status
    }

    func didRegister(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        token = hex
        try? keychain.set(Data(hex.utf8), account: Self.account, protection: .whenUnlocked)
    }
}
