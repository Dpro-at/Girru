import Foundation

/// What the app's own screens show, read from the computer with signed
/// commands (tasks.list, schedules.list, approval.pending, team.list). Loaded
/// when a screen opens and again every few seconds while it stays open.
@MainActor
final class PhoneData: ObservableObject {
    @Published private(set) var running: [TaskItem] = []
    @Published private(set) var waiting: [TaskItem] = []
    @Published private(set) var finished: [TaskItem] = []
    @Published private(set) var schedules: [ScheduleItem] = []
    @Published private(set) var approvals: [ApprovalCard] = []
    @Published private(set) var team: [TeamMember] = []
    /// A plain sentence when the computer could not be reached; nil when fine.
    @Published private(set) var problem: String?

    private let model: AppModel

    init(model: AppModel) { self.model = model }

    /// The agents with their status, for the Team screen and for names elsewhere.
    var board: [TeamMember] { TeamBoard.members(team, running: running, approvals: approvals) }

    func name(of agentId: String?) -> String? {
        guard let agentId else { return nil }
        return team.first { $0.id == agentId }?.name
    }

    func loadTasks() async {
        if let r = await load(try CommandBody.tasksList(place: "running"), TaskItem.list) { running = r }
        if let w = await load(try CommandBody.tasksList(place: "waiting"), TaskItem.list) { waiting = w }
    }

    func loadFinished() async {
        if let f = await load(try CommandBody.tasksList(place: "finished"), TaskItem.list) { finished = f }
    }

    func loadSchedules() async {
        if let s = await load(try CommandBody.schedulesList(), ScheduleItem.list) { schedules = s }
    }

    func loadApprovals() async {
        if let a = await load(try CommandBody.approvalList(), ApprovalCard.list) { approvals = a }
    }

    func loadTeam() async {
        if let t = await load(try CommandBody.teamList(), TeamMember.list) { team = t }
    }

    func loadAll() async {
        await loadTeam()
        await loadApprovals()
        await loadTasks()
    }

    func decide(_ card: ApprovalCard, approve: Bool) async {
        await model.decide(card.summary, approve: approve)
        await loadApprovals()
    }

    private func load<T>(_ body: @autoclosure () throws -> String, _ parse: (Any?) throws -> T) async -> T? {
        do {
            let r = try await model.send(try body())
            guard r.ok else { problem = CommandFailure.message(for: r.error ?? "internal_error"); return nil }
            problem = nil
            return try parse(r.data)
        } catch is AppLocked {
            return nil
        } catch {
            problem = "Cannot reach your computer. Is Girru open there?"
            return nil
        }
    }
}
