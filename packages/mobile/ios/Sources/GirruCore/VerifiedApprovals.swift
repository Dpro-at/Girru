import Foundation

/// Approval ids from notices that passed `Notice.open` (signed by the computer,
/// sealed with the notification key). The extension records them; the app acts
/// on a notification button only for an id found here, and takes "sensitive"
/// from the recorded kind, never from the notification's category or userInfo,
/// which a forged push can set.
public struct VerifiedApprovals: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public var sensitive: Bool
        public var receivedAt: Date
    }

    public static let maxEntries = 32
    /// An approval button older than this is ignored; the owner uses Approvals.
    public static let lifetime: TimeInterval = 24 * 60 * 60

    public private(set) var entries: [String: Entry] = [:]

    public init() {}

    /// Records a verified notice. Non-approvals are ignored.
    public mutating func record(_ notice: NoticeContent, now: Date = Date()) {
        guard notice.isApproval, let id = notice.approvalId else { return }
        prune(now: now)
        entries[id] = Entry(sensitive: notice.kind == .approvalSensitive, receivedAt: now)
        while entries.count > Self.maxEntries, let oldest = entries.min(by: { $0.value.receivedAt < $1.value.receivedAt })?.key {
            entries.removeValue(forKey: oldest)
        }
    }

    /// Returns the entry and removes it, so one button press acts once.
    /// nil = not a verified approval (or too old): do nothing.
    public mutating func take(_ id: String, now: Date = Date()) -> Entry? {
        prune(now: now)
        return entries.removeValue(forKey: id)
    }

    private mutating func prune(now: Date) {
        entries = entries.filter { _, e in
            let age = now.timeIntervalSince(e.receivedAt)
            return age >= 0 && age <= Self.lifetime
        }
    }
}
