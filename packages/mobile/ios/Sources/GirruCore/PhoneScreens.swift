import Foundation

// What the app's own screens show (phone boards Tasks, Approvals, Team, Empty),
// read from the signed commands tasks.list, schedules.list, approval.pending
// and team.list. Only the chat is the computer's page; these screens are
// native. Text comes from the computer already cleaned; nothing here is sent.

/// An agent of the owner's team (`team.list`).
public struct TeamMember: Identifiable, Equatable, Sendable {
    public enum Status: Equatable, Sendable { case working, needsYou, free }

    public var id: String
    public var name: String
    public var emoji: String?
    public var primary: Bool
    public var role: String?
    public var department: String?
    public var description: String?
    public var status: Status = .free
    /// What it does now (a running task's title), or nil.
    public var doing: String?

    /// "Main agent · sorting the inbox", "Marketing · waiting for your OK", "Support".
    public var subtitle: String {
        let place = primary ? "Main agent" : (department.map(PhoneText.title) ?? role.map(PhoneText.title) ?? "")
        let now: String? = status == .needsYou ? "waiting for your OK" : doing
        return [place, now].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
    }

    public static func list(from data: Any?) throws -> [TeamMember] {
        guard let d = data as? [String: Any], let agents = d["agents"] as? [[String: Any]] else { throw ProtocolError.badFormat }
        return agents.compactMap { a in
            guard let id = a["id"] as? String, let name = a["name"] as? String else { return nil }
            return TeamMember(id: id, name: name, emoji: a["emoji"] as? String, primary: ComputerMessage.bool(a["primary"]) ?? false,
                              role: a["role"] as? String, department: a["department"] as? String, description: a["description"] as? String)
        }
    }
}

/// A task (`tasks.list`): running, waiting for the owner, or finished.
public struct TaskItem: Identifiable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var agentId: String?
    public var agentName: String?
    public var needsYou: Bool
    public var reason: String?
    public var approvalId: String?
    public var sessionId: String?
    public var startedAt: Date?
    public var endedAt: Date?

    /// "Karim · checking the second draft" style: who, then why it waits or stopped.
    public var subtitle: String {
        let who = agentName ?? "Girru"
        if needsYou { return "\(who) needs your OK" }
        if let reason, !reason.isEmpty { return "\(who) · \(reason)" }
        return who
    }

    public static func list(from data: Any?) throws -> [TaskItem] {
        guard let d = data as? [String: Any], let runs = d["runs"] as? [[String: Any]] else { throw ProtocolError.badFormat }
        return runs.compactMap { r in
            guard let id = r["id"] as? String, let title = r["title"] as? String else { return nil }
            let link = r["link"] as? [String: Any] ?? [:]
            let reason = (r["reason"] as? [String: Any])?["title"] as? String
            return TaskItem(id: id, title: title, agentId: r["agentId"] as? String, agentName: r["agentName"] as? String,
                            needsYou: ComputerMessage.bool(r["needsYou"]) ?? false, reason: reason,
                            approvalId: link["approvalId"] as? String, sessionId: link["sessionId"] as? String,
                            startedAt: PhoneText.date(r["startedAt"]), endedAt: PhoneText.date(r["endedAt"]))
        }
    }
}

/// A scheduled task (`schedules.list`).
public struct ScheduleItem: Identifiable, Equatable, Sendable {
    public var id: String
    public var title: String
    /// "Every day at 2:00", as the computer writes it.
    public var when: String
    public var enabled: Bool
    public var nextRun: Date?
    public var agentName: String?

    public static func list(from data: Any?) throws -> [ScheduleItem] {
        guard let d = data as? [String: Any], let items = d["schedules"] as? [[String: Any]] else { throw ProtocolError.badFormat }
        return items.compactMap { s in
            guard let id = s["id"] as? String, let title = s["title"] as? String else { return nil }
            return ScheduleItem(id: id, title: title, when: s["when"] as? String ?? "", enabled: ComputerMessage.bool(s["enabled"]) ?? true,
                                nextRun: PhoneText.date(s["nextRun"]), agentName: s["agentName"] as? String)
        }
        // Soonest first; paused ones last.
        .sorted { a, b in
            if a.enabled != b.enabled { return a.enabled }
            return (a.nextRun ?? .distantFuture) < (b.nextRun ?? .distantFuture)
        }
    }
}

/// One card of the Approvals screen: what the agent wants, in plain words.
public struct ApprovalCard: Identifiable, Equatable, Sendable {
    public var summary: ApprovalSummary
    public var agentId: String?
    public var category: String?
    public var requestedAt: Date?
    /// The preview's fields as "name: value" lines (already masked and cut by the computer).
    public var lines: [(String, String)]

    public var id: String { summary.id }

    public static func == (a: ApprovalCard, b: ApprovalCard) -> Bool {
        a.summary == b.summary && a.agentId == b.agentId && a.category == b.category && a.requestedAt == b.requestedAt
            && a.lines.map { $0.0 + "\u{0}" + $0.1 } == b.lines.map { $0.0 + "\u{0}" + $0.1 }
    }

    /// "Sara wants to send an email" from the agent's name and the tool.
    public func title(agentName: String?) -> String {
        "\(agentName ?? "An agent") wants to \(PhoneText.action(summary.toolName))"
    }

    public static func list(from data: Any?) throws -> [ApprovalCard] {
        let summaries = try ApprovalSummary.list(from: data)
        let items = (data as? [String: Any])?["approvals"] as? [[String: Any]] ?? []
        return zip(summaries, items).map { s, j in
            ApprovalCard(summary: s, agentId: j["agentId"] as? String, category: j["category"] as? String,
                         requestedAt: PhoneText.date(j["requestedAt"]), lines: PhoneText.lines(j["paramsPreview"]))
        }
    }
}

/// The Team screen: status from what runs and what waits, filtered by the chips and search.
public enum TeamBoard {
    public static let all = "All"
    public static let needsYou = "Needs you"

    public static func members(_ team: [TeamMember], running: [TaskItem], approvals: [ApprovalCard]) -> [TeamMember] {
        let waiting = Set(approvals.compactMap(\.agentId))
        var doing: [String: String] = [:]
        for t in running { if let a = t.agentId, doing[a] == nil { doing[a] = t.title } }
        return team.map { m in
            var m = m
            if waiting.contains(m.id) { m.status = .needsYou } else if let d = doing[m.id] { m.status = .working; m.doing = d }
            return m
        }
        // The main agent first, then who needs the owner, then who works, then by name.
        .sorted { a, b in
            if a.primary != b.primary { return a.primary }
            let rank: (TeamMember.Status) -> Int = { $0 == .needsYou ? 0 : $0 == .working ? 1 : 2 }
            if rank(a.status) != rank(b.status) { return rank(a.status) < rank(b.status) }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    /// All, Needs you (when someone does), then each department once.
    public static func chips(_ members: [TeamMember]) -> [String] {
        var out = [all]
        if members.contains(where: { $0.status == .needsYou }) { out.append(needsYou) }
        var seen = Set<String>()
        for m in members { if let d = m.department.map(PhoneText.title), !d.isEmpty, seen.insert(d).inserted { out.append(d) } }
        return out
    }

    public static func filter(_ members: [TeamMember], chip: String, query: String) -> [TeamMember] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return members.filter { m in
            let inChip = chip == all || (chip == needsYou ? m.status == .needsYou : m.department.map(PhoneText.title) == chip)
            let hay = [m.name, m.role ?? "", m.department ?? "", m.description ?? ""].joined(separator: " ").lowercased()
            return inChip && (q.isEmpty || hay.contains(q))
        }
    }
}

/// Small text helpers shared by the native screens.
public enum PhoneText {
    /// "sales_ops" → "Sales ops".
    public static func title(_ s: String) -> String {
        let words = s.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ").trimmingCharacters(in: .whitespaces)
        guard let first = words.first else { return "" }
        return first.uppercased() + words.dropFirst()
    }

    /// A tool name as an action: "send_email" → "send an email", "web.publish_page" → "publish a page".
    public static func action(_ tool: String) -> String {
        let last = tool.split(whereSeparator: { $0 == "." || $0 == ":" || $0 == "/" }).last.map(String.init) ?? tool
        let words = last.replacingOccurrences(of: "-", with: "_").split(separator: "_").map { $0.lowercased() }
        guard let verb = words.first else { return "use a tool" }
        guard words.count > 1 else { return "use \(verb)" }
        let rest = words.dropFirst().joined(separator: " ")
        let article = rest.hasSuffix("s") ? "" : (["a", "e", "i", "o", "u"].contains(rest.first.map(String.init) ?? "") ? "an " : "a ")
        return "\(verb) \(article)\(rest)"
    }

    public static func date(_ v: Any?) -> Date? {
        guard let s = v as? String else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    /// The preview's top-level fields as lines; nested values read "…".
    public static func lines(_ preview: Any?) -> [(String, String)] {
        guard let p = preview as? [String: Any] else {
            if let s = preview as? String, !s.isEmpty { return [("", s)] }
            return []
        }
        return p.keys.sorted().prefix(8).map { k in
            let v = p[k]
            let text: String
            switch v {
            case let s as String: text = s
            case let n as NSNumber: text = ComputerMessage.bool(n).map { $0 ? "yes" : "no" } ?? n.stringValue
            case is NSNull, nil: text = "—"
            default: text = "…"
            }
            return (title(k), String(text.prefix(600)))
        }
    }
}
