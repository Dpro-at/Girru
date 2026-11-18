import SwiftUI

/// Phone boards Approvals, ApprovalsDark and Empty: what agents wait for. The
/// first request is open; tap another to open it. Approve walks the same steps
/// as a notification button (full view first when the preview was cut short)
/// and asks Face ID right before the key signs. The board's "Note for …" field
/// waits for a note in `approval.decide` on the computer.
struct ApprovalsScreen: View {
    let openTeam: () -> Void
    @EnvironmentObject private var data: PhoneData
    @State private var open: String?
    @State private var busy: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScreenTitle("Approvals")
            ProblemLine(text: data.problem)
            ScrollView {
                VStack(spacing: 12) {
                    if data.approvals.isEmpty {
                        EmptyNote(icon: "checkmark", text: "Nothing is waiting for you",
                                  detail: "When an agent needs your OK, it shows here and your phone tells you.",
                                  action: ("See what the team is doing", openTeam))
                    }
                    ForEach(data.approvals) { card in
                        if (open ?? data.approvals.first?.id) == card.id {
                            ApprovalCardView(card: card, agentName: data.name(of: card.agentId), busy: busy == card.id) { approve in
                                busy = card.id
                                Task {
                                    await data.decide(card, approve: approve)
                                    busy = nil
                                    open = nil
                                }
                            }
                        } else {
                            Button { open = card.id } label: { ApprovalRow(card: card, agentName: data.name(of: card.agentId)) }
                                .buttonStyle(.plain)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .refreshable { await data.loadApprovals() }
        }
        .background(Theme.background)
        .task {
            await data.loadTeam()
            while !Task.isCancelled {
                await data.loadApprovals()
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }
}

struct ApprovalCardView: View {
    let card: ApprovalCard
    let agentName: String?
    let busy: Bool
    let decide: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                AgentAvatar(id: card.agentId ?? "agent", size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(card.title(agentName: agentName)).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                    if let at = card.requestedAt {
                        Text(at, style: .relative).font(.system(size: 13)).foregroundStyle(Theme.secondaryText) + Text(" ago").font(.system(size: 13)).foregroundStyle(Theme.secondaryText)
                    }
                }
            }
            if !card.lines.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(card.lines.enumerated()), id: \.offset) { _, line in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            if !line.0.isEmpty { Text(line.0).foregroundStyle(Theme.secondaryText).frame(minWidth: 44, alignment: .leading) }
                            Text(line.1).foregroundStyle(Theme.text).lineLimit(4)
                        }
                        .font(.system(size: 14))
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.quote, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            if card.summary.needsFullView {
                Text("Approve opens the full request first.").font(.system(size: 13)).foregroundStyle(Theme.secondaryText)
            }
            HStack(spacing: 10) {
                Button("Deny") { decide(false) }
                    .font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.border))
                Button("Approve") { decide(true) }
                    .buttonStyle(PrimaryButtonStyle())
            }
            .disabled(busy)
            .opacity(busy ? 0.6 : 1)
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Theme.border))
    }
}

struct ApprovalRow: View {
    let card: ApprovalCard
    let agentName: String?

    var body: some View {
        HStack(spacing: 12) {
            AgentAvatar(id: card.agentId ?? "agent", size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title(agentName: agentName)).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                Text(card.summary.needsFullView ? "Open to read it all" : "Tap to read").font(.system(size: 13)).foregroundStyle(Theme.secondaryText)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.footnote).foregroundStyle(Theme.secondaryText)
        }
        .padding(.vertical, 14).padding(.horizontal, 16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.border))
        .contentShape(Rectangle())
    }
}
