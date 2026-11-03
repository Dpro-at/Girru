import Foundation
import UserNotifications

/// Opens the sealed notice on the phone and shows the real text. Apple and the
/// relay only ever carry the sealed form. Anything that does not verify is
/// replaced by a neutral line, never shown as sent.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var fallback: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        let neutral = Self.neutral()
        fallback = neutral

        let store = PairingStore()
        guard let computer = store.load(), !computer.isExpired() else {
            contentHandler(neutral)
            return
        }
        var window = store.loadNoticeWindow()
        do {
            let notice = try Notice.open(userInfo: request.content.userInfo, computer: computer, replay: &window, crypto: CryptoKitPairingCrypto())
            try store.saveNoticeWindow(window)
            if notice.isApproval {
                // Only ids recorded here can be acted on from the buttons.
                var approvals = store.loadVerifiedApprovals()
                approvals.record(notice)
                try store.saveVerifiedApprovals(approvals)
            }
            contentHandler(Self.content(for: notice))
        } catch {
            contentHandler(neutral)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler, let fallback { contentHandler(fallback) }
    }

    /// Shown when a notice cannot be opened. The relay's own visible text is
    /// never trusted, so it is replaced rather than passed through.
    static func neutral() -> UNMutableNotificationContent {
        let c = UNMutableNotificationContent()
        c.title = "Girru"
        c.body = "Something on your computer needs a look. Open Girru."
        c.sound = .default
        return c
    }

    static func content(for notice: NoticeContent) -> UNMutableNotificationContent {
        let c = UNMutableNotificationContent()
        c.title = notice.title
        c.body = notice.body
        if let group = notice.group { c.threadIdentifier = group }
        switch notice.kind {
        case .approval:
            c.categoryIdentifier = NoticeCategory.approval
            c.sound = .default
        case .approvalSensitive:
            c.categoryIdentifier = NoticeCategory.approvalSensitive
            c.sound = .default
        case .security:
            c.sound = .default
            c.interruptionLevel = .timeSensitive
        case .taskFailed:
            c.sound = .default
        case .summary:
            // Calm by default: grouped summaries make no sound.
            c.interruptionLevel = .passive
        }
        if let id = notice.approvalId { c.userInfo = [NoticeCategory.approvalIdKey: id] }
        return c
    }
}
