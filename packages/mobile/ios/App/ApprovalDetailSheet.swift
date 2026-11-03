import SwiftUI

extension ApprovalDetail: Identifiable {}

/// The full parameters of an approval whose preview was cut short. The owner
/// reads them here before Approve signs (PROTOCOL.md "Full view"). Cancel
/// leaves the request waiting; it can still be decided on the computer.
struct ApprovalDetailSheet: View {
    @EnvironmentObject private var model: AppModel
    let detail: ApprovalDetail

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(detail.toolName)
                        .font(.headline)
                        .foregroundStyle(Theme.text)
                    if !detail.maskedFields.isEmpty {
                        Text("Hidden for safety: \(detail.maskedFields.joined(separator: ", "))")
                            .font(.footnote)
                            .foregroundStyle(Theme.secondaryText)
                    }
                    Text(detail.paramsText)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(Theme.text)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(16)
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Check before you approve")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { model.dismissFullView() } }
                ToolbarItem(placement: .confirmationAction) { Button("Approve") { Task { await model.approveFullView() } } }
            }
        }
        .interactiveDismissDisabled()
    }
}
