import Foundation

/// The app lock cannot be turned off. The owner may only pick a shorter
/// re-lock delay than the default; there is no "never" value to pick.
public struct LockPolicy: Codable, Equatable, Sendable {
    public static let maximumDelay: TimeInterval = 60
    /// Seconds in the background before the next open asks again.
    public static let choices: [TimeInterval] = [0, 15, 30, 60]

    public private(set) var relockDelay: TimeInterval

    public init(relockDelay: TimeInterval = LockPolicy.maximumDelay) {
        self.relockDelay = Self.clamp(relockDelay)
    }

    /// Stored values are clamped too, so an edited file cannot loosen the lock.
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        relockDelay = Self.clamp((try? c.decode(Double.self)) ?? Self.maximumDelay)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(relockDelay)
    }

    /// Returns false for anything not offered in `choices`.
    @discardableResult
    public mutating func setRelockDelay(_ delay: TimeInterval) -> Bool {
        guard Self.choices.contains(delay) else { return false }
        relockDelay = delay
        return true
    }

    /// `backgroundedAt == nil` means a fresh launch, which always locks.
    /// A clock that moved backwards also locks: we cannot trust the gap.
    public func shouldLock(backgroundedAt: Date?, now: Date) -> Bool {
        guard let since = backgroundedAt else { return true }
        let gap = now.timeIntervalSince(since)
        guard gap >= 0 else { return true }
        return gap >= relockDelay
    }

    private static func clamp(_ value: TimeInterval) -> TimeInterval {
        guard value.isFinite, value >= 0 else { return maximumDelay }
        return min(value, maximumDelay)
    }
}
