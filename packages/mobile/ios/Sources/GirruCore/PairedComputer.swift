import Foundation

/// How long a pairing lasts without use, PROTOCOL.md "Pairing lifetime".
/// The phone never asks to scan again while the pairing is valid.
public enum PairingLifetime: String, Codable, CaseIterable, Sendable {
    case days30 = "30d"
    case days60 = "60d"
    case days90 = "90d"
    case days120 = "120d"
    case never

    /// The computer's default when nothing was picked.
    public static let `default`: PairingLifetime = .days90

    /// Maps the wire value (days, or nil for never). Any other number is refused.
    public init?(days: Int?) {
        switch days {
        case nil: self = .never
        case 30: self = .days30
        case 60: self = .days60
        case 90: self = .days90
        case 120: self = .days120
        default: return nil
        }
    }

    public var days: Int? {
        switch self {
        case .days30: return 30
        case .days60: return 60
        case .days90: return 90
        case .days120: return 120
        case .never: return nil
        }
    }

    public var duration: TimeInterval? { days.map { TimeInterval($0) * 86_400 } }

    public var title: String {
        days.map { "\($0) days" } ?? "Never expires"
    }

    /// The one-line warning shown next to "Never expires".
    public var warning: String? {
        self == .never ? "A lost phone stays paired until you remove it on your computer." : nil
    }
}

/// Why the phone shows the pairing screen again.
public enum PairingEndReason: String, Codable, Equatable, Sendable {
    case expired
    case revoked
    case refusedByComputer

    public var message: String {
        switch self {
        case .expired: return "This phone was not used for a while, so the pairing ended. Pair again."
        case .revoked: return "This phone was removed on your computer. Pair again."
        case .refusedByComputer: return "Your computer no longer accepts this phone. Pair again."
        }
    }
}

/// A computer this phone is paired with. Stored only in the Keychain.
public struct PairedComputer: Codable, Equatable, Sendable {
    public var computerId: String
    public var computerName: String?
    /// The computer's identity public key, SPKI DER.
    public var computerKey: Data
    /// Relay name exactly as in the QR code (`wss://<host>/v1`).
    public var relay: String?
    public var localAddresses: [String]
    /// This phone's device id at the time of pairing.
    public var phoneId: String
    /// Per-phone key that opens push notices.
    public var notifyKey: Data
    public var pairedAt: Date
    public var lifetime: PairingLifetime
    /// Sliding expiry counts from here; every authenticated use moves it on.
    public var lastUsedAt: Date

    public init(computerId: String, computerName: String?, computerKey: Data, relay: String?, localAddresses: [String], phoneId: String, notifyKey: Data, pairedAt: Date, lifetime: PairingLifetime) {
        self.computerId = computerId
        self.computerName = computerName
        self.computerKey = computerKey
        self.relay = relay
        self.localAddresses = localAddresses
        self.phoneId = phoneId
        self.notifyKey = notifyKey
        self.pairedAt = pairedAt
        self.lifetime = lifetime
        self.lastUsedAt = pairedAt
    }

    /// nil = never expires.
    public var expiresAt: Date? {
        lifetime.duration.map { lastUsedAt.addingTimeInterval($0) }
    }

    /// The phone's own view, same rule as the computer (expired only once the
    /// whole lifetime has passed). The computer stays the final authority.
    public func isExpired(now: Date = Date()) -> Bool {
        guard let d = lifetime.duration else { return false }
        return now.timeIntervalSince(lastUsedAt) > d
    }

    /// Call after an authenticated exchange (accepted command or finished
    /// handshake). Never moves back (clock changes), never revives an expired one.
    @discardableResult
    public mutating func renew(at now: Date = Date()) -> Bool {
        guard !isExpired(now: now) else { return false }
        if now > lastUsedAt { lastUsedAt = now }
        return true
    }
}

/// What the app shows after the app lock.
public enum PairingState: Equatable, Sendable {
    case notPaired
    case paired(PairedComputer)
    case ended(PairingEndReason)

    public static func evaluate(_ stored: PairedComputer?, now: Date = Date()) -> PairingState {
        guard let p = stored else { return .notPaired }
        return p.isExpired(now: now) ? .ended(.expired) : .paired(p)
    }
}
