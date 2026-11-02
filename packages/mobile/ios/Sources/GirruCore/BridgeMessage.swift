import Foundation

/// Messages core-ui may send to the native shell through
/// `window.webkit.messageHandlers.girru.postMessage({...})`, which returns a
/// Promise with the reply. Anything not listed here is refused.
public enum BridgeRequest: Equatable, Sendable {
    /// { type: "lock.state" } → { locked: Bool, relockDelay: Number }
    case lockState
    /// { type: "auth.request", reason: String } → { ok: Bool }
    /// Asks Face ID / Touch ID / passcode again, even while unlocked.
    case authenticate(reason: String)
    /// { type: "qr.scan" } → { text: String } or { cancelled: true }
    case scanQR
    /// { type: "push.permission", request?: Bool } → { status: String }
    case pushPermission(request: Bool)
}

public enum BridgeError: Error, Equatable {
    case notAnObject
    case unknownType
    case unexpectedField(String)
    case invalidField(String)
}

public enum BridgeMessageParser {
    public static let maxReasonLength = 120

    public static func parse(_ body: Any) throws -> BridgeRequest {
        guard let dict = body as? [String: Any] else { throw BridgeError.notAnObject }
        guard let type = dict["type"] as? String else { throw BridgeError.unknownType }

        func onlyKeys(_ allowed: Set<String>) throws {
            for key in dict.keys where key != "type" && !allowed.contains(key) {
                throw BridgeError.unexpectedField(key)
            }
        }

        switch type {
        case "lock.state":
            try onlyKeys([])
            return .lockState
        case "auth.request":
            try onlyKeys(["reason"])
            guard let reason = dict["reason"] as? String else { throw BridgeError.invalidField("reason") }
            let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
            // The reason appears in the system prompt; keep it short and plain.
            guard !trimmed.isEmpty, trimmed.count <= maxReasonLength,
                  !trimmed.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
                throw BridgeError.invalidField("reason")
            }
            return .authenticate(reason: trimmed)
        case "qr.scan":
            try onlyKeys([])
            return .scanQR
        case "push.permission":
            try onlyKeys(["request"])
            guard let raw = dict["request"] else { return .pushPermission(request: false) }
            // NSNumber bridges both Bool and numbers; insist on a real boolean.
            guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
                throw BridgeError.invalidField("request")
            }
            return .pushPermission(request: number.boolValue)
        default:
            throw BridgeError.unknownType
        }
    }
}
