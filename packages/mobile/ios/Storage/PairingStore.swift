import Foundation

/// The pairing lives only in the Keychain (never UserDefaults, files or caches).
/// "After first unlock" so the notification extension can read the computer's
/// key and the notification key while the phone is locked; the identity key,
/// which signs commands, stays behind user presence (DeviceIdentity).
struct PairingStore {
    private static let computerAccount = "paired-computer"
    private static let noticeWindowAccount = "notice-replay-window"
    private static let approvalsAccount = "verified-approvals"
    static let counterAccount = "command-counter"

    let keychain: KeychainStore

    init(keychain: KeychainStore = .shared) { self.keychain = keychain }

    func load() -> PairedComputer? {
        guard let data = try? keychain.get(account: Self.computerAccount) else { return nil }
        return try? JSONDecoder().decode(PairedComputer.self, from: data)
    }

    func save(_ computer: PairedComputer) throws {
        try keychain.set(try JSONEncoder().encode(computer), account: Self.computerAccount, protection: .afterFirstUnlock)
    }

    /// Forgets the computer and everything tied to it.
    func clear() {
        keychain.delete(account: Self.computerAccount)
        keychain.delete(account: Self.noticeWindowAccount)
        keychain.delete(account: Self.approvalsAccount)
        keychain.delete(account: Self.counterAccount)
    }

    func loadNoticeWindow() -> ReplayWindow {
        guard let data = try? keychain.get(account: Self.noticeWindowAccount),
              let w = try? JSONDecoder().decode(ReplayWindow.self, from: data) else { return ReplayWindow() }
        return w
    }

    func saveNoticeWindow(_ window: ReplayWindow) throws {
        try keychain.set(try JSONEncoder().encode(window), account: Self.noticeWindowAccount, protection: .afterFirstUnlock)
    }

    /// Written only by the notification extension, after a notice verified.
    func loadVerifiedApprovals() -> VerifiedApprovals {
        guard let data = try? keychain.get(account: Self.approvalsAccount),
              let v = try? JSONDecoder().decode(VerifiedApprovals.self, from: data) else { return VerifiedApprovals() }
        return v
    }

    func saveVerifiedApprovals(_ approvals: VerifiedApprovals) throws {
        try keychain.set(try JSONEncoder().encode(approvals), account: Self.approvalsAccount, protection: .afterFirstUnlock)
    }
}

/// The outgoing command counter, kept in the Keychain so it survives restarts
/// (the computer refuses any counter it has already seen).
final class KeychainCounterStore: CounterStore {
    private let keychain: KeychainStore

    init(keychain: KeychainStore = .shared) { self.keychain = keychain }

    func load() -> UInt64 {
        guard let data = try? keychain.get(account: PairingStore.counterAccount), data.count == 8 else { return 0 }
        return data.reduce(0) { ($0 << 8) | UInt64($1) }
    }

    func save(_ value: UInt64) throws {
        var bytes = Data(count: 0)
        withUnsafeBytes(of: value.bigEndian) { bytes.append(contentsOf: $0) }
        try keychain.set(bytes, account: PairingStore.counterAccount, protection: .whenUnlocked)
    }
}
