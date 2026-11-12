import Foundation

// What travels inside a session (PROTOCOL.md "Inside a session: requests and
// answers"): one JSON object per g1.msg envelope. The phone sends signed
// commands (whose `body` is built here) and the one unsigned query
// `approval.pending {id}`; the computer answers with reply, run and run.end.

/// Command bodies, written with sorted keys. The computer reads them as JSON
/// and does not depend on key order; the signature covers the exact text.
public enum CommandBody {
    /// `ref`: 1 to 64 letters, digits, `-` or `_`.
    public static func isValidRef(_ ref: String) -> Bool {
        (1...64).contains(ref.count) && ref.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "-" || $0 == "_" }
    }

    public static func make(_ type: String, _ fields: [String: Any] = [:], ref: String? = nil) throws -> String {
        var obj = fields
        obj["type"] = type
        if let ref {
            guard isValidRef(ref) else { throw ProtocolError.badFormat }
            obj["ref"] = ref
        }
        let data = try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self)
    }

    public static func chatMessages(conversationId: String, before: String? = nil, ref: String? = nil) throws -> String {
        var f: [String: Any] = ["id": conversationId]
        if let before { f["before"] = before }
        return try make("chat.messages", f, ref: ref)
    }

    /// The unsigned "is this approval still pending?" query; sent as the
    /// message itself, not inside a signed command.
    public static func approvalPendingQuery(id: String) throws -> String {
        try make("approval.pending", ["id": id])
    }

    /// The pending approvals, each recorded on the computer as given to this phone.
    public static func approvalList(ref: String? = nil) throws -> String {
        try make("approval.pending", ref: ref)
    }

    public static func approvalDetail(id: String, ref: String? = nil) throws -> String {
        try make("approval.detail", ["id": id], ref: ref)
    }

    /// `paramsHash` is required to approve and optional to deny.
    public static func approvalDecide(id: String, approve: Bool, paramsHash: String?, ref: String? = nil) throws -> String {
        guard !approve || paramsHash != nil else { throw ProtocolError.badFormat }
        if let h = paramsHash, !ApprovalSummary.isHash(h) { throw ProtocolError.badFormat }
        var f: [String: Any] = ["id": id, "approve": approve]
        if let paramsHash { f["paramsHash"] = paramsHash }
        return try make("approval.decide", f, ref: ref)
    }

    /// `place`: running, waiting, finished or failed.
    public static func tasksList(place: String, ref: String? = nil) throws -> String {
        try make("tasks.list", ["place": place], ref: ref)
    }

    public static func schedulesList(ref: String? = nil) throws -> String { try make("schedules.list", ref: ref) }

    public static func teamList(ref: String? = nil) throws -> String { try make("team.list", ref: ref) }

    /// Phone Settings (boards P33–P39). Sections: general, account, replies, permissions,
    /// approval-rules, computers, phones.
    public static let settingsSections: Set<String> = ["general", "account", "replies", "permissions", "approval-rules", "computers", "phones"]

    public static func settingsRead(section: String, ref: String? = nil) throws -> String {
        guard settingsSections.contains(section) else { throw ProtocolError.badFormat }
        return try make("settings.read", ["section": section], ref: ref)
    }

    /// `confirmed` only right after a fresh Face ID check (AppLock.confirmSensitive).
    public static func settingsChange(section: String, change: [String: Any], confirmed: Bool = false, ref: String? = nil) throws -> String {
        guard settingsSections.contains(section), !change.isEmpty else { throw ProtocolError.badFormat }
        var f: [String: Any] = ["section": section, "change": change]
        if confirmed { f["confirmed"] = true }
        return try make("settings.change", f, ref: ref)
    }

    /// One file of the computer's chat page (PROTOCOL.md "The computer's pages on the phone").
    public static func uiGet(path: String, part: Int, ref: String) throws -> String {
        var f: [String: Any] = ["path": path]
        if part > 0 { f["part"] = part }
        return try make("ui.get", f, ref: ref)
    }

    /// One request of the chat page; `body` is its JSON, nil for none.
    public static func apiCall(method: String, path: String, body: Any?, ref: String) throws -> String {
        var f: [String: Any] = ["method": method, "path": path]
        if let body { f["body"] = body }
        return try make("api.call", f, ref: ref)
    }

    public static func apiStream(path: String, ref: String) throws -> String {
        try make("api.stream", ["path": path], ref: ref)
    }
}

/// How a run ended, as the phone acts on it.
public enum RunEnd: Equatable, Sendable {
    case complete
    case stopped
    /// The computer stopped streaming (the link was backed up, `slow_link`),
    /// or no longer knows the run: read the rest with `chat.messages`.
    case reread
    /// Failed on the computer; shown as a plain failure, never the raw code.
    case failed

    public init(status: String, code: String?) {
        switch status {
        case "complete", "completed", "done": self = code == "internal_error" ? .failed : .complete
        case "stopped", "cancelled", "canceled", "aborted": self = .stopped
        case "dropped", "unknown": self = .reread
        default: self = .failed
        }
    }
}

/// A message from the computer inside the session.
public enum ComputerMessage {
    /// `data` is the parsed JSON answer (or nil). `ref` is the body's `ref`,
    /// else the command's nonce; nil when the message could not be read.
    case reply(ref: String?, ok: Bool, data: Any?, error: String?)
    case run(ref: String?, runId: String, seq: UInt64, frame: [String: Any])
    case runEnd(ref: String?, runId: String, end: RunEnd, code: String?)
    /// The answer to the unsigned `approval.pending {id}` query.
    case approvalPending(id: String, pending: Bool)
    /// One event of an `api.stream`, as the chat page reads it.
    /// `event` names the stream's `event:` line (a terminal's `output` / `exit`); nil for a run.
    case stream(ref: String?, data: [String: Any], event: String?)
    /// The end of an `api.stream`: `complete`, or `dropped` (re-attach with `after`).
    case streamEnd(ref: String?, complete: Bool)

    public static func parse(_ plaintext: Data) throws -> ComputerMessage {
        guard let obj = try? JSONSerialization.jsonObject(with: plaintext), let m = obj as? [String: Any], let type = m["type"] as? String else {
            throw ProtocolError.badFormat
        }
        let ref = m["ref"] as? String
        switch type {
        case "reply":
            guard let ok = bool(m["ok"]) else { throw ProtocolError.badFormat }
            if ok { return .reply(ref: ref, ok: true, data: m["data"], error: nil) }
            guard let error = m["error"] as? String else { throw ProtocolError.badFormat }
            return .reply(ref: ref, ok: false, data: nil, error: error)
        case "run":
            guard let runId = m["runId"] as? String, let frame = m["frame"] as? [String: Any] else { throw ProtocolError.badFormat }
            return .run(ref: ref, runId: runId, seq: try G1Text.integer(m["seq"]), frame: frame)
        case "run.end":
            guard let runId = m["runId"] as? String, let status = m["status"] as? String else { throw ProtocolError.badFormat }
            let code = m["code"] as? String
            return .runEnd(ref: ref, runId: runId, end: RunEnd(status: status, code: code), code: code)
        case "approval.pending":
            guard let id = m["id"] as? String, let p = bool(m["pending"]) else { throw ProtocolError.badFormat }
            return .approvalPending(id: id, pending: p)
        case "stream":
            guard let data = m["data"] as? [String: Any] else { throw ProtocolError.badFormat }
            let event = (m["event"] as? String).flatMap { e in e.range(of: "^[a-z][a-z0-9_]{0,31}$", options: .regularExpression) != nil ? e : nil }
            return .stream(ref: ref, data: data, event: event)
        case "stream.end":
            guard let status = m["status"] as? String else { throw ProtocolError.badFormat }
            return .streamEnd(ref: ref, complete: status == "complete")
        default:
            throw ProtocolError.badFormat
        }
    }

    /// A JSON true / false, never a number.
    static func bool(_ v: Any?) -> Bool? {
        guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
        return n.boolValue
    }
}

/// What the owner reads when a command was refused. Raw codes are never shown.
public enum CommandFailure {
    /// Codes after which the owner decides the approval on the computer.
    public static let decideOnComputer: Set<String> = ["full_view_required", "full_view_unavailable", "too_large", "verification_required"]

    public static func message(for code: String) -> String {
        switch code {
        case "full_view_required", "full_view_unavailable", "too_large":
            return "This request is too large to check on the phone. Approve or deny it on your computer."
        case "verification_required":
            return "Your account asks for a second check. Approve or deny this on your computer."
        case "not_pending":
            return "This request is no longer waiting."
        case "not_found":
            return "This is no longer on your computer."
        case "expired", "unknown_device", "revoked":
            return "Your computer no longer accepts this phone. Pair again."
        case "confirmation_required", "risky_confirmation_required":
            return "This change needs Face ID first. Try again."
        case "on_the_computer":
            return "Change this in Girru on your computer."
        case "changed":
            return "This changed on your computer meanwhile. The latest values are shown; choose again."
        default:
            // internal_error and anything unexpected.
            return "Something went wrong on your computer. Try again."
        }
    }
}
