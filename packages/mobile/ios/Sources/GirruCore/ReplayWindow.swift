import Foundation

/// Sliding replay window over a sender's counter (the IPsec scheme): each
/// counter is accepted once, and only if it is newer than, or within the last
/// 64 of, the highest one seen. Used for push notices, which Apple may deliver
/// out of order; session envelopes use the stricter "above the last" rule.
public struct ReplayWindow: Codable, Equatable, Sendable {
    public static let size: UInt64 = 64

    public private(set) var highest: UInt64 = 0
    /// Bit i set = counter (highest - i) was seen.
    public private(set) var seen: UInt64 = 0

    public init() {}

    /// Checks and records in one step, so a check without a record is impossible.
    public mutating func accept(_ counter: UInt64) -> Bool {
        guard counter > 0 else { return false }
        if counter > highest {
            let shift = counter - highest
            seen = shift >= Self.size ? 0 : seen << shift
            seen |= 1
            highest = counter
            return true
        }
        let offset = highest - counter
        guard offset < Self.size else { return false }
        let bit: UInt64 = 1 << offset
        guard seen & bit == 0 else { return false }
        seen |= bit
        return true
    }
}
