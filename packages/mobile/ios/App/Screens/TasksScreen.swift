import SwiftUI

/// Phone board Tasks: what waits for the owner, what runs, what comes next.
/// The terminal button opens the computer's terminal after Face ID / Touch ID
/// (the owner's decision).
struct TasksScreen: View {
    enum Show: String, CaseIterable { case now = "Now", scheduled = "Scheduled", done = "Done" }

    let openChat: () -> Void
    let openApprovals: () -> Void
    let openTerminal: () -> Void
    @EnvironmentObject private var data: PhoneData
    @State private var show: Show = .now

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScreenTitle(text: "Tasks") {
                Button(action: openTerminal) {
                    Image(systemName: "apple.terminal").font(.system(size: 20)).foregroundStyle(Theme.secondaryText)
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Terminal")
                Button(action: openChat) {
                    Image(systemName: "plus").font(.system(size: 20, weight: .semibold)).foregroundStyle(.white)
                        .frame(width: 44, height: 44).background(Theme.accent, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .accessibilityLabel("New task")
            }
            Picker("Show", selection: $show) {
                ForEach(Show.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
            ProblemLine(text: data.problem)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    switch show {
                    case .now: now
                    case .scheduled: scheduled
                    case .done: done
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .refreshable { await load() }
        }
        .background(Theme.background)
        .task(id: show) {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    private func load() async {
        switch show {
        case .now:
            await data.loadTasks()
            await data.loadSchedules()
        case .scheduled: await data.loadSchedules()
        case .done: await data.loadFinished()
        }
    }

    @ViewBuilder private var now: some View {
        if data.waiting.isEmpty && data.running.isEmpty && data.schedules.isEmpty {
            EmptyNote(icon: "checkmark", text: "Nothing is running now", detail: "Ask an agent in Chat and its work shows here.")
        }
        if !data.waiting.isEmpty {
            SectionLabel("Waiting for you", color: Theme.waiting)
            ForEach(data.waiting) { t in
                Button(action: openApprovals) {
                    TaskRow(task: t, chevron: true)
                        .padding(.vertical, 12).padding(.horizontal, 14)
                        .background(Theme.waitingCard, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.waitingBorder))
                }
                .buttonStyle(.plain)
            }
        }
        if !data.running.isEmpty {
            SectionLabel("Running").padding(.top, 6)
            CardList(data.running) { TaskRow(task: $0, chevron: false) }
        }
        if let next = data.schedules.first(where: \.enabled) {
            SectionLabel("Next scheduled").padding(.top, 6)
            CardList([next]) { ScheduleRow(item: $0) }
        }
    }

    @ViewBuilder private var scheduled: some View {
        if data.schedules.isEmpty {
            EmptyNote(icon: "calendar", text: "Nothing is scheduled", detail: "Ask an agent in Chat to do something every day or week.")
        } else {
            CardList(data.schedules) { ScheduleRow(item: $0) }
        }
    }

    @ViewBuilder private var done: some View {
        if data.finished.isEmpty {
            EmptyNote(icon: "checkmark", text: "No finished tasks yet", detail: nil)
        } else {
            CardList(data.finished) { TaskRow(task: $0, chevron: false) }
        }
    }
}

struct TaskRow: View {
    let task: TaskItem
    let chevron: Bool

    var body: some View {
        HStack(spacing: 12) {
            AgentAvatar(id: task.agentId ?? "girru", size: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(task.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                Text(task.subtitle).font(.system(size: 13)).foregroundStyle(Theme.secondaryText).lineLimit(1)
            }
            Spacer(minLength: 0)
            if chevron { Image(systemName: "chevron.right").font(.footnote).foregroundStyle(Theme.secondaryText) }
        }
        .contentShape(Rectangle())
    }
}

struct ScheduleRow: View {
    let item: ScheduleItem

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "calendar").font(.system(size: 16)).foregroundStyle(Theme.accent)
                .frame(width: 34, height: 34).background(Theme.quote, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                Text(item.enabled ? (item.nextRun.map(Self.next) ?? item.when) : "Paused · \(item.when)")
                    .font(.system(size: 13)).foregroundStyle(Theme.secondaryText).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
    }

    /// "Tonight at 2:00", "Tomorrow at 9:00", "Mon 9 Nov at 9:00".
    static func next(_ date: Date) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        let cal = Calendar.current
        if cal.isDateInToday(date) { return cal.component(.hour, from: date) >= 18 || cal.component(.hour, from: date) < 5 ? "Tonight at \(time)" : "Today at \(time)" }
        if cal.isDateInTomorrow(date) { return cal.component(.hour, from: date) < 5 ? "Tonight at \(time)" : "Tomorrow at \(time)" }
        return "\(date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))) at \(time)"
    }
}

/// Rows in one card with thin lines between them (boards Tasks, Team).
struct CardList<Item: Identifiable, Row: View>: View {
    let items: [Item]
    let row: (Item) -> Row

    init(_ items: [Item], @ViewBuilder row: @escaping (Item) -> Row) {
        self.items = items
        self.row = row
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                row(item).padding(.vertical, 12).padding(.horizontal, 14)
                if i < items.count - 1 { Divider().overlay(Theme.divider) }
            }
        }
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.border))
    }
}

struct SectionLabel: View {
    let text: String
    var color: Color = Theme.secondaryText

    init(_ text: String, color: Color = Theme.secondaryText) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text).font(.system(size: 12, weight: .semibold)).foregroundStyle(color).padding(.horizontal, 4).padding(.top, 4)
    }
}

/// One sentence and, when there is one, one action (board Empty).
struct EmptyNote: View {
    let icon: String
    let text: String
    let detail: String?
    var action: (title: String, run: () -> Void)?

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: icon).font(.system(size: 28, weight: .semibold)).foregroundStyle(Theme.done)
                .frame(width: 64, height: 64).background(Theme.doneSoft, in: Circle())
            Text(text).font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text)
            if let detail { Text(detail).font(.system(size: 15)).foregroundStyle(Theme.secondaryText).multilineTextAlignment(.center) }
            if let action { Button(action.title, action: action.run).font(.system(size: 15)).padding(.top, 6) }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .padding(.top, 80)
    }
}
