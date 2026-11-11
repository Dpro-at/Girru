import SwiftUI

/// Phone board Team: the owner's agents with what each does now. Search by name
/// or job; chips for who needs the owner and each department. Tapping an agent
/// opens Chat.
struct TeamScreen: View {
    let openChat: () -> Void
    @EnvironmentObject private var data: PhoneData
    @State private var query = ""
    @State private var chip = TeamBoard.all

    var body: some View {
        let board = data.board
        let shown = TeamBoard.filter(board, chip: chip, query: query)
        VStack(alignment: .leading, spacing: 0) {
            ScreenTitle(text: "Team") {
                Button { NotificationCenter.default.post(name: .girruOpenSettings, object: nil) } label: {
                    Image(systemName: "gearshape").font(.system(size: 20)).frame(width: 44, height: 44)
                }
                .foregroundStyle(Theme.text)
                .accessibilityLabel("Settings")
            }
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.secondaryText)
                TextField("Search by name or job", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            .font(.system(size: 15))
            .padding(.horizontal, 12)
            .frame(height: 40)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.border))
            .padding(.horizontal, 16)
            .padding(.bottom, 10)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(TeamBoard.chips(board), id: \.self) { c in
                        Button(c) { chip = c }
                            .font(.system(size: 14, weight: chip == c ? .semibold : .regular))
                            .foregroundStyle(chip == c ? Color.white : Theme.text)
                            .padding(.horizontal, 14).frame(height: 34)
                            .background(chip == c ? Theme.accent : Theme.surface, in: Capsule())
                            .overlay(Capsule().stroke(chip == c ? Color.clear : Theme.border))
                            .accessibilityAddTraits(chip == c ? .isSelected : [])
                    }
                }
                .padding(.horizontal, 16)
            }
            .padding(.bottom, 12)
            ProblemLine(text: data.problem)
            ScrollView {
                if shown.isEmpty {
                    EmptyNote(icon: "person.2", text: query.isEmpty ? "No agents here" : "No one matches", detail: nil)
                } else {
                    CardList(shown) { m in
                        Button(action: openChat) { MemberRow(member: m) }.buttonStyle(.plain)
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
            }
            .refreshable { await data.loadAll() }
        }
        .background(Theme.background)
        .task {
            while !Task.isCancelled {
                await data.loadAll()
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }
}

struct MemberRow: View {
    let member: TeamMember

    var body: some View {
        HStack(spacing: 12) {
            AgentAvatar(id: member.id, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(member.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                Text(member.subtitle).font(.system(size: 13)).foregroundStyle(Theme.secondaryText).lineLimit(1)
            }
            Spacer(minLength: 0)
            switch member.status {
            case .working: Text("Working").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.accent)
            case .needsYou: Text("Needs you").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.waiting)
            case .free: Text("Free").font(.system(size: 12)).foregroundStyle(Theme.secondaryText)
            }
        }
        .contentShape(Rectangle())
    }
}
