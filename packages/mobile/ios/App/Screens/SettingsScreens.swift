import SwiftUI
import UIKit

/// Phone Settings (boards P33–P38): what the owner changes while away. This
/// phone's own settings stay on the phone; the computer's sections are read and
/// changed with `settings.read` / `settings.change`. Changes marked with a lock
/// ask Face ID first and are sent as confirmed; the computer refuses them otherwise.
@MainActor
final class SettingsData: ObservableObject {
    @Published private(set) var views: [String: [String: Any]] = [:]
    /// A plain sentence when something did not work; nil when fine.
    @Published var problem: String?
    @Published private(set) var busy = false

    private let model: AppModel
    init(model: AppModel) { self.model = model }

    func view(_ section: String) -> [String: Any] { views[section] ?? [:] }

    func read(_ section: String) async {
        do {
            let r = try await model.send(try CommandBody.settingsRead(section: section))
            guard r.ok, let v = r.data as? [String: Any] else { problem = CommandFailure.message(for: r.error ?? "internal_error"); return }
            views[section] = v
            problem = nil
        } catch is AppLocked {
            return
        } catch {
            problem = "Cannot reach your computer. Is Girru open there?"
        }
    }

    /// One change. `faceID` is the reason shown by Face ID for a locked change; nil for a plain one.
    @discardableResult
    func change(_ section: String, _ change: [String: Any], faceID: String? = nil) async -> Bool {
        if let reason = faceID {
            guard await model.lock.confirmSensitive(reason: reason) != nil else { return false }
        }
        busy = true
        defer { busy = false }
        do {
            let r = try await model.send(try CommandBody.settingsChange(section: section, change: change, confirmed: faceID != nil))
            if !r.ok { problem = CommandFailure.message(for: r.error ?? "internal_error") } else { problem = nil }
            await read(section)
            return r.ok
        } catch is AppLocked {
            return false
        } catch {
            problem = "Cannot reach your computer. Is Girru open there?"
            return false
        }
    }
}

private func rows(_ v: Any?) -> [[String: Any]] { (v as? [Any])?.compactMap { $0 as? [String: Any] } ?? [] }
private func text(_ v: Any?) -> String? { v as? String }

/// Board P33: the Settings home. Opened from the chat drawer's gear or Team's gear.
struct SettingsScreen: View {
    let computer: PairedComputer
    let close: () -> Void
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            SettingsHome(computer: computer, data: SettingsData(model: model), lock: model.lock)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done", action: close) } }
        }
        .tint(Theme.accent)
    }
}

private struct SettingsHome: View {
    let computer: PairedComputer
    @StateObject var data: SettingsData
    @ObservedObject var lock: AppLock

    var body: some View {
        List {
            Section("This phone") {
                NavigationLink { ThisPhoneScreen(computer: computer, data: data, lock: lock) } label: {
                    Label { VStack(alignment: .leading, spacing: 2) {
                        Text(computer.computerName ?? "Your computer")
                        Text("Anywhere").font(.footnote).foregroundStyle(Theme.secondaryText)
                    } } icon: { Image(systemName: "desktopcomputer") }
                }
                LabeledContent { Text(LockWords.word(lock.policy.relockDelay)) } label: { Label("Ask Face ID again", systemImage: "lock") }
            }
            Section {
                NavigationLink { AccountScreen(data: data) } label: { Label("Account and general", systemImage: "person.crop.circle") }
                NavigationLink { ModelsScreen(data: data) } label: { Label("Models and replies", systemImage: "cpu") }
                NavigationLink { PermissionsScreen(data: data) } label: { LockedLabel("Permissions", icon: "slider.horizontal.3") }
                NavigationLink { ReadOnlyScreen(data: data, section: "approval-rules", title: "Approval rules", key: "rules") } label: { Label("Approval rules", systemImage: "checkmark.shield") }
                NavigationLink { ReadOnlyScreen(data: data, section: "computers", title: "Computers", key: "computers") } label: { Label("Computers", systemImage: "display.2") }
                NavigationLink { PhonesScreen(data: data) } label: { LockedLabel("Phones", icon: "iphone") }
            } header: { Text("Your computer") } footer: {
                Text("Keys, connections, memory, voice, backups and updates stay in Girru on your computer.")
            }
        }
        .navigationTitle("Settings")
    }
}

private struct LockedLabel: View {
    let title: String, icon: String
    init(_ title: String, icon: String) { self.title = title; self.icon = icon }
    var body: some View {
        HStack {
            Label(title, systemImage: icon)
            Spacer()
            Image(systemName: "lock.fill").font(.footnote).foregroundStyle(Theme.waiting).accessibilityLabel("Asks for Face ID")
        }
    }
}

enum LockWords {
    static func word(_ delay: TimeInterval) -> String {
        switch delay { case 0: return "Right away"; case 15: return "After 15 s"; case 30: return "After 30 s"; default: return "After 1 min" }
    }
    static func short(_ delay: TimeInterval) -> String {
        switch delay { case 0: return "Right away"; case 15: return "15 s"; case 30: return "30 s"; default: return "1 min" }
    }
}

/// Board P34: this phone's own settings.
private struct ThisPhoneScreen: View {
    let computer: PairedComputer
    @ObservedObject var data: SettingsData
    @ObservedObject var lock: AppLock
    @EnvironmentObject private var model: AppModel
    @State private var confirmForget = false

    var body: some View {
        let general = data.view("general")
        List {
            Section {
                HStack(spacing: 12) {
                    Image(systemName: "desktopcomputer").font(.system(size: 22)).foregroundStyle(Theme.accent).frame(width: 44, height: 44)
                        .background(Theme.quote, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(computer.computerName ?? "Your computer").font(.system(size: 17, weight: .semibold))
                        Text("Paired with this phone").font(.footnote).foregroundStyle(Theme.secondaryText)
                    }
                }
            }
            Section("How this phone reaches it") {
                LabeledContent { Image(systemName: "checkmark").foregroundStyle(Theme.accent) } label: {
                    VStack(alignment: .leading, spacing: 2) { Text("Anywhere"); Text("Through the Girru relay, locked end to end").font(.footnote).foregroundStyle(Theme.secondaryText) }
                }
                LabeledContent { Text("New").font(.caption.weight(.bold)).foregroundStyle(.white).padding(.horizontal, 6).padding(.vertical, 2).background(Theme.done, in: Capsule()) } label: {
                    VStack(alignment: .leading, spacing: 2) { Text("Only on this Wi-Fi"); Text("Never uses the relay. Coming in a later version.").font(.footnote).foregroundStyle(Theme.secondaryText) }
                }
                .foregroundStyle(Theme.secondaryText)
            }
            Section {
                Picker("Ask Face ID again", selection: Binding(get: { lock.policy.relockDelay }, set: { lock.setRelockDelay($0) })) {
                    ForEach(LockPolicy.choices, id: \.self) { Text(LockWords.short($0)).tag($0) }
                }
                .pickerStyle(.segmented)
            } header: { Text("Face ID after leaving the app") } footer: { Text("The terminal and the changes marked with a lock always ask.") }
            Section("Notifications") {
                Toggle("Long work is done", isOn: Binding(get: { general["notifyDone"] as? Bool ?? true }, set: { v in Task { await data.change("general", ["notifyDone": v]) } }))
                if general["otherComputers"] is Bool {
                    Toggle("From my other computers", isOn: Binding(get: { general["otherComputers"] as? Bool ?? false }, set: { v in Task { await data.change("general", ["otherComputers": v]) } }))
                }
                Button("Approvals and other alerts on this iPhone") {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                }
            }
            if let p = data.problem { Section { Text(p).foregroundStyle(Theme.waiting) } }
            Section {
                Button(role: .destructive) { confirmForget = true } label: { Label("Forget this computer…", systemImage: "lock.fill") }
            } footer: { Text("This phone stops reaching it. Pair again with a new code.") }
        }
        .navigationTitle(computer.computerName ?? "This phone")
        .task { await data.read("general") }
        .confirmationDialog("Forget this computer?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Forget", role: .destructive) { Task { await forget() } }
        } message: { Text("Your chats stay on the computer.") }
    }

    private func forget() async {
        // Face ID once; the computer is told when it can be reached, and this phone forgets it either way.
        guard await model.lock.confirmSensitive(reason: "Forget this computer") != nil else { return }
        await data.read("phones")
        if let id = text(rows(data.view("phones")["phones"]).first(where: { $0["thisPhone"] as? Bool == true })?["id"]) {
            _ = try? await model.send(try CommandBody.settingsChange(section: "phones", change: ["forget": id], confirmed: true))
        }
        model.unpairThisPhone()
    }

}

/// Board P35: what each agent may do. Every change asks Face ID; money, installs and deleting also ask once more.
private struct PermissionsScreen: View {
    @ObservedObject var data: SettingsData
    @State private var agentId: String?
    @State private var risky: (agent: String, action: String)?

    private static let names: [String: String] = ["browser": "Use the browser", "network": "Reach the internet", "message": "Send messages", "delete": "Delete things", "install": "Install software", "money": "Spend money", "settings": "Change settings"]
    private static let riskyActions: Set<String> = ["money", "install", "delete"]

    var body: some View {
        let v = data.view("permissions")
        let agents = rows(v["agents"])
        let actions = (v["actions"] as? [String]) ?? Array(Self.names.keys).sorted()
        let selected = agents.first { text($0["id"]) == agentId } ?? agents.first
        List {
            if !agents.isEmpty {
                Section {
                    Picker("Agent", selection: Binding(get: { agentId ?? text(selected?["id"]) ?? "" }, set: { agentId = $0 })) {
                        ForEach(agents.indices, id: \.self) { i in Text(text(agents[i]["name"]) ?? "Agent").tag(text(agents[i]["id"]) ?? "") }
                    }
                }
            }
            if let a = selected, let id = text(a["id"]) {
                let modes = a["modes"] as? [String: Any] ?? [:]
                Section {
                    ForEach(actions, id: \.self) { action in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(Self.names[action] ?? action)
                            Picker(Self.names[action] ?? action, selection: Binding(get: { modes[action] as? String ?? "ask" }, set: { mode in
                                if mode == "allow" && Self.riskyActions.contains(action) { risky = (id, action) } else {
                                    Task { await data.change("permissions", ["agentId": id, "action": action, "mode": mode], faceID: "Change what \(text(a["name"]) ?? "this agent") may do") }
                                }
                            })) {
                                Text("Off").tag("off"); Text("Ask").tag("ask"); Text("Allow").tag("allow")
                            }
                            .pickerStyle(.segmented)
                            .labelsHidden()
                        }
                        .padding(.vertical, 4)
                    }
                } header: { Text("What it may do") } footer: { Text("Every change asks for Face ID. Tools and memory are set on your computer.") }
            }
            if let p = data.problem { Section { Text(p).foregroundStyle(Theme.waiting) } }
        }
        .disabled(data.busy)
        .navigationTitle("Permissions")
        .task { await data.read("permissions") }
        .refreshable { await data.read("permissions") }
        .alert("Allow without asking you?", isPresented: Binding(get: { risky != nil }, set: { if !$0 { risky = nil } }), presenting: risky) { r in
            Button("Allow", role: .destructive) {
                Task { await data.change("permissions", ["agentId": r.agent, "action": r.action, "mode": "allow", "risky": true], faceID: "Allow without asking") }
            }
            Button("Cancel", role: .cancel) {}
        } message: { r in Text("\(Self.names[r.action] ?? r.action) will run without asking you first.") }
    }
}

/// Board P37: which model the main agent answers with.
private struct ModelsScreen: View {
    @ObservedObject var data: SettingsData

    var body: some View {
        let v = data.view("replies")
        let main = v["main"] as? [String: Any]
        let current = text(main?["model"])
        List {
            Section {
                ForEach(rows(v["models"]).indices, id: \.self) { i in
                    let m = rows(v["models"])[i]
                    Button {
                        guard let id = text(main?["id"]), let model = text(m["id"]), let version = main?["version"] as? Int else { return }
                        Task { await data.change("replies", ["agentId": id, "model": model, "version": version]) }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(text(m["label"]) ?? text(m["id"]) ?? "Model").foregroundStyle(Theme.text)
                                if m["local"] as? Bool == true { Text("On your computer · free").font(.footnote).foregroundStyle(Theme.secondaryText) }
                            }
                            Spacer()
                            if text(m["id"]) == current { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
                        }
                    }
                }
            } header: { Text("\(text(main?["name"]) ?? "Main Agent") answers with") } footer: {
                Text("A model for each agent is chosen in Team. Signing in to a new coding app happens on your computer.")
            }
            if let p = data.problem { Section { Text(p).foregroundStyle(Theme.waiting) } }
        }
        .disabled(data.busy)
        .navigationTitle("Models and replies")
        .task { await data.read("replies") }
    }
}

/// Board P38: account and general.
private struct AccountScreen: View {
    @ObservedObject var data: SettingsData

    var body: some View {
        let v = data.view("account")
        List {
            Section("Sign-in") {
                LabeledContent("Two-step sign-in") { Text((v["twoStep"] as? Bool) == true ? "On" : (v["twoStep"] as? Bool) == false ? "Off" : "—") }
            }
            Section {
                ForEach(rows(v["sessions"]).indices, id: \.self) { i in
                    let s = rows(v["sessions"])[i]
                    HStack {
                        Text(text(s["label"]) ?? "Device")
                        Spacer()
                        if s["current"] as? Bool == true { Text("This one").font(.footnote).foregroundStyle(Theme.secondaryText) }
                        else if let id = text(s["id"]) {
                            Button("Sign out", role: .destructive) { Task { await data.change("account", ["signOut": id], faceID: "Sign a device out") } }
                                .buttonStyle(.borderless)
                        }
                    }
                }
            } header: { Text("Signed in on") } footer: { Text("Signing out asks for Face ID. Two-step sign-in is set on your computer.") }
            Section("General") {
                LabeledContent("Appearance") { Text("Like the iPhone") }
                LabeledContent("Language") { Text("English") }
            }
            if let p = data.problem { Section { Text(p).foregroundStyle(Theme.waiting) } }
        }
        .navigationTitle("Account")
        .task { await data.read("account") }
    }
}

/// Approval rules and computers: read only on the phone (board P39).
private struct ReadOnlyScreen: View {
    @ObservedObject var data: SettingsData
    let section: String, title: String, key: String

    var body: some View {
        let items = rows(data.view(section)[key])
        List {
            Section {
                if items.isEmpty { Text("Nothing here yet").foregroundStyle(Theme.secondaryText) }
                ForEach(items.indices, id: \.self) { i in
                    LabeledContent(text(items[i]["name"]) ?? "—") { Text(text(items[i]["state"]) ?? "") }
                }
            } footer: { Text("Change these in Girru on your computer.") }
            if let p = data.problem { Section { Text(p).foregroundStyle(Theme.waiting) } }
        }
        .navigationTitle(title)
        .task { await data.read(section) }
    }
}

/// Phones paired with the computer; forgetting another phone asks Face ID.
private struct PhonesScreen: View {
    @ObservedObject var data: SettingsData

    var body: some View {
        let phones = rows(data.view("phones")["phones"])
        List {
            Section {
                ForEach(phones.indices, id: \.self) { i in
                    let p = phones[i]
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(text(p["name"]) ?? "Phone")
                            Text(p["thisPhone"] as? Bool == true ? "This phone" : (text(p["status"]) ?? "")).font(.footnote).foregroundStyle(Theme.secondaryText)
                        }
                        Spacer()
                        if p["thisPhone"] as? Bool != true, let id = text(p["id"]) {
                            Button("Forget", role: .destructive) { Task { await data.change("phones", ["forget": id], faceID: "Forget a phone") } }
                                .buttonStyle(.borderless)
                        }
                    }
                }
            } footer: { Text("Pairing a new phone happens on your computer.") }
            if let p = data.problem { Section { Text(p).foregroundStyle(Theme.waiting) } }
        }
        .navigationTitle("Phones")
        .task { await data.read("phones") }
    }
}
