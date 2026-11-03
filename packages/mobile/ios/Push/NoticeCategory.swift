import Foundation
import UserNotifications

/// Actionable categories for approvals (board P12: Deny / Approve on the lock
/// screen). Shared by the app and the notification extension.
enum NoticeCategory {
    static let approval = "girru.approval"
    static let approvalSensitive = "girru.approval.sensitive"
    static let approveAction = "girru.approve"
    static let denyAction = "girru.deny"
    static let approvalIdKey = "approvalId"

    /// Both buttons need the phone unlocked (.authenticationRequired) and open
    /// the app (.foreground): the decision is a signed command, and the
    /// identity key only signs behind the app lock. For a sensitive approval
    /// the app also asks Face ID again before signing.
    static func register(on center: UNUserNotificationCenter = .current()) {
        let deny = UNNotificationAction(identifier: denyAction, title: "Deny", options: [.authenticationRequired, .foreground, .destructive])
        let approve = UNNotificationAction(identifier: approveAction, title: "Approve", options: [.authenticationRequired, .foreground])
        let normal = UNNotificationCategory(identifier: approval, actions: [deny, approve], intentIdentifiers: [], options: [])
        let sensitive = UNNotificationCategory(identifier: approvalSensitive, actions: [deny, approve], intentIdentifiers: [], options: [])
        center.setNotificationCategories([normal, sensitive])
    }
}
