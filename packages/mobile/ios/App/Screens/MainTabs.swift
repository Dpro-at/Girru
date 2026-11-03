import SwiftUI

/// The four places after pairing (phone boards): Chat is the computer's own
/// chat page; Tasks, Approvals and Team are the app's own screens.
struct MainTabs: View {
    enum Place: Hashable { case chat, tasks, approvals, team }

    let computer: PairedComputer
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var bridge: WebBridge
    @EnvironmentObject private var lock: AppLock
    @StateObject private var data: PhoneData
    @State private var place: Place = .chat

    init(computer: PairedComputer, model: AppModel) {
        self.computer = computer
        _data = StateObject(wrappedValue: PhoneData(model: model))
    }

    var body: some View {
        TabView(selection: $place) {
            WebHostView(computer: computer, bridge: bridge, source: SessionCoreUISource(send: { [model] body, stream in
                try await model.send(body, stream: stream)
            }, terminal: data.terminal, confirm: { [model] reason in
                await model.lock.confirmSensitive(reason: reason) != nil
            }))
            .tabItem { Label("Chat", systemImage: "message") }
            .tag(Place.chat)

            TasksScreen(openChat: { place = .chat }, openApprovals: { place = .approvals }, openTerminal: openTerminal)
                .tabItem { Label("Tasks", systemImage: "chart.bar.doc.horizontal") }
                .tag(Place.tasks)

            ApprovalsScreen(openTeam: { place = .team })
                .tabItem { Label("Approvals", systemImage: "tray") }
                .badge(data.approvals.count)
                .tag(Place.approvals)

            TeamScreen(openChat: { place = .chat })
                .tabItem { Label("Team", systemImage: "person.2") }
                .tag(Place.team)
        }
        .tint(Theme.accent)
        .environmentObject(data)
        // Locking forgets every terminal: the next use asks for the check again.
        .onChange(of: lock.state) { _, state in if state != .unlocked { data.terminal.forget() } }
        // The badge stays current while the app is open; nothing is read while it is locked.
        .task {
            while !Task.isCancelled {
                await data.loadApprovals()
                try? await Task.sleep(for: .seconds(20))
            }
        }
    }
}

extension MainTabs {
    /// The terminal button: Face ID / Touch ID / passcode first, then the chat page opens its terminal full size.
    func openTerminal() {
        Task { @MainActor in
            guard await model.lock.confirmSensitive(reason: "Open the terminal") != nil else { return }
            data.terminal.checked()
            place = .chat
            NotificationCenter.default.post(name: .girruOpenTerminal, object: nil)
        }
    }
}

extension Notification.Name {
    /// Asks the chat page to open its terminal (WebHostView sets #terminal).
    static let girruOpenTerminal = Notification.Name("dev.girru.app.openTerminal")
}

/// An agent's round picture: its colour and the person mark from the boards.
struct AgentAvatar: View {
    let id: String
    var size: CGFloat = 40

    var body: some View {
        Circle()
            .fill(Theme.avatar(for: id))
            .frame(width: size, height: size)
            .overlay {
                Image(systemName: "person.fill")
                    .font(.system(size: size * 0.5))
                    .foregroundStyle(.white.opacity(0.92))
                    .offset(y: size * 0.08)
            }
            .clipShape(Circle())
            .accessibilityHidden(true)
    }
}

/// A screen's big title, as on the boards.
struct ScreenTitle<Trailing: View>: View {
    let text: String
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 6) {
            Text(text).font(.system(size: 30, weight: .bold)).foregroundStyle(Theme.text)
            Spacer()
            trailing
        }
        .padding(.horizontal, 18)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }
}

extension ScreenTitle where Trailing == EmptyView {
    init(_ text: String) { self.text = text; self.trailing = EmptyView() }
}

/// "Cannot reach your computer" under a title, when it applies.
struct ProblemLine: View {
    let text: String?
    var body: some View {
        if let text {
            Text(text).font(.footnote).foregroundStyle(Theme.secondaryText).padding(.horizontal, 18).padding(.bottom, 6)
        }
    }
}
