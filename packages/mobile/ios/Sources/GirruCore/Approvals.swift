import Foundation

// Approvals from the phone, PROTOCOL.md "Approvals from the phone" and
// "Full view". The list carries a preview; a cut-short preview
// (`truncated` or `fullViewRequired`) is approved only after the phone fetched
// `approval.detail`, showed the full parameters, and signs with the
// `paramsHash` of that full view.

/// One entry of the `approval.pending` list.
public struct ApprovalSummary: Equatable, Sendable {
    public var id: String
    public var toolName: String
    public var paramsHash: String?
    public var truncated: Bool
    public var fullViewRequired: Bool

    public var needsFullView: Bool { truncated || fullViewRequired }

    /// 64 lower-case hex characters.
    public static func isHash(_ s: String) -> Bool {
        s.utf8.count == 64 && s.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
    }

    public init(id: String, toolName: String, paramsHash: String?, truncated: Bool, fullViewRequired: Bool) {
        self.id = id
        self.toolName = toolName
        self.paramsHash = paramsHash
        self.truncated = truncated
        self.fullViewRequired = fullViewRequired
    }

    public init(json: [String: Any]) throws {
        guard let id = json["id"] as? String, let tool = json["toolName"] as? String else { throw ProtocolError.badFormat }
        let hash = json["paramsHash"] as? String
        if let hash, !Self.isHash(hash) { throw ProtocolError.badFormat }
        self.init(id: id, toolName: tool, paramsHash: hash,
                  truncated: ComputerMessage.bool(json["truncated"]) ?? false,
                  fullViewRequired: ComputerMessage.bool(json["fullViewRequired"]) ?? false)
    }

    /// The `approvals` array of an `approval.pending` reply.
    public static func list(from data: Any?) throws -> [ApprovalSummary] {
        guard let d = data as? [String: Any], let items = d["approvals"] as? [[String: Any]] else { throw ProtocolError.badFormat }
        return try items.map(ApprovalSummary.init(json:))
    }
}

/// The answer to `approval.detail {id}`: full parameters, secrets masked.
public struct ApprovalDetail: Equatable, Sendable {
    public var id: String
    public var toolName: String
    public var category: String?
    public var agentId: String?
    public var paramsHash: String
    /// Where the computer masked secrets.
    public var maskedFields: [String]
    /// The full parameters, as indented JSON text for the owner to read.
    public var paramsText: String

    /// `askedId` is the id the phone sent; an answer for another approval is refused.
    public init(data: Any?, askedId: String) throws {
        guard let d = data as? [String: Any], let id = d["id"] as? String, id == askedId,
              let tool = d["toolName"] as? String,
              let hash = d["paramsHash"] as? String, ApprovalSummary.isHash(hash),
              d.keys.contains("params") else { throw ProtocolError.badFormat }
        let params = d["params"] ?? NSNull()
        guard let text = try? JSONSerialization.data(withJSONObject: params, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed]) else {
            throw ProtocolError.badFormat
        }
        self.id = id
        self.toolName = tool
        self.category = d["category"] as? String
        self.agentId = d["agentId"] as? String
        self.paramsHash = hash
        self.maskedFields = (d["maskedFields"] as? [Any])?.compactMap { $0 as? String } ?? []
        self.paramsText = String(decoding: text, as: UTF8.self)
    }
}

/// The next thing the phone does for one decision.
public enum ApprovalStep: Equatable, Sendable {
    /// Sign and send this `approval.decide` body.
    case decide(body: String)
    /// Sign and send this `approval.detail` body, then call `afterDetail`.
    case fetchFullView(body: String)
    /// Show the full parameters; on the owner's Approve, sign `approveBody(detail)`.
    case showFullView(ApprovalDetail)
    /// Plain text: the owner decides on the computer.
    case decideOnComputer(String)
}

public enum ApprovalFlow {
    /// Deny needs no full view; approve needs one when the preview was cut short.
    public static func start(_ s: ApprovalSummary, approve: Bool) throws -> ApprovalStep {
        if !approve { return .decide(body: try CommandBody.approvalDecide(id: s.id, approve: false, paramsHash: s.paramsHash)) }
        if s.needsFullView { return .fetchFullView(body: try CommandBody.approvalDetail(id: s.id)) }
        guard let hash = s.paramsHash else { return .decideOnComputer(CommandFailure.message(for: "full_view_unavailable")) }
        return .decide(body: try CommandBody.approvalDecide(id: s.id, approve: true, paramsHash: hash))
    }

    /// The reply to `approval.detail`. `full_view_unavailable`, `too_large`
    /// (and any other refusal) send the owner to the computer.
    public static func afterDetail(ok: Bool, data: Any?, error: String?, askedId: String) -> ApprovalStep {
        guard ok else { return .decideOnComputer(CommandFailure.message(for: error ?? "internal_error")) }
        guard let d = try? ApprovalDetail(data: data, askedId: askedId) else {
            return .decideOnComputer(CommandFailure.message(for: "full_view_unavailable"))
        }
        return .showFullView(d)
    }

    /// Approves exactly the parameters that were shown.
    public static func approveBody(_ d: ApprovalDetail) throws -> String {
        try CommandBody.approvalDecide(id: d.id, approve: true, paramsHash: d.paramsHash)
    }
}
