import SwiftUI
import UIKit
import UserNotifications

@main
struct GirruApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(delegate.model)
                .environmentObject(delegate.model.lock)
                .environmentObject(delegate.model.pairingFlow)
                .environmentObject(delegate.push)
                .environmentObject(delegate.bridge)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let model = AppModel()
    let push = PushRegistrar()
    lazy var bridge = WebBridge(lock: model.lock, push: push)

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        NoticeCategory.register(on: center)
        // Refresh the token without prompting; the prompt comes from core-ui
        // (push.permission) at a moment that makes sense to the owner.
        Task { await push.refresh(ask: false) }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        push.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Nothing to show: the app works without push, and Settings explains it.
    }

    /// While the app is open, live updates replace pushes: keep the notice in
    /// the list but do not show a banner over the app.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.list, .badge])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let action = response.actionIdentifier
        // Only a lookup key: queueDecision acts on it only if the extension
        // recorded it from a verified notice. Category and kind are ignored.
        let approvalId = response.notification.request.content.userInfo[NoticeCategory.approvalIdKey] as? String
        Task { @MainActor in
            if let approvalId, action == NoticeCategory.approveAction || action == NoticeCategory.denyAction {
                self.model.queueDecision(approvalId: approvalId, approve: action == NoticeCategory.approveAction)
            }
            completionHandler()
        }
    }
}
