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
    /// { type: "chat.open", id: String } → { ok: Bool }
    /// From Tasks › Board (phone board P48): show this chat in the Chat tab.
    case openChat(id: String)
}

public enum BridgeError: Error, Equatable {
    case notAnObject
    case unknownType
    case unexpectedField(String)
    case invalidField(String)
}

public enum BridgeMessageParser {
    public static let maxReasonLength = 120

    /// A chat id as core-ui's `#chat=<id>` link accepts it (chat-actions.tsx › chatFromLink).
    public static func isChatId(_ id: String) -> Bool {
        let scalars = Array(id.unicodeScalars)
        guard (8...64).contains(scalars.count), let first = scalars.first, first.isASCII,
              CharacterSet.alphanumerics.contains(first) else { return false }
        return scalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-") }
    }

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
        case "chat.open":
            try onlyKeys(["id"])
            guard let id = dict["id"] as? String, isChatId(id) else { throw BridgeError.invalidField("id") }
            return .openChat(id: id)
        default:
            throw BridgeError.unknownType
        }
    }
}

/// Who may use the bridge, and when. Kept here so the rules are checked
/// without UIKit.
public enum BridgeGate {
    /// Only core-ui served by the app's own scheme handler, main frame only.
    public static func allowsOrigin(scheme: String, host: String, isMainFrame: Bool) -> Bool {
        isMainFrame && scheme.lowercased() == CoreUIOrigin.scheme && host.lowercased() == CoreUIOrigin.host
    }

    /// While locked, a page may only ask whether the app is locked.
    public static func allows(_ request: BridgeRequest, unlocked: Bool) -> Bool {
        if case .lockState = request { return true }
        return unlocked
    }
}
