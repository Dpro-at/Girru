import SwiftUI
import UIKit

/// Board P1: pair with your computer. One main action: scan the code.
struct PairingView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var flow: PairingFlow
    @EnvironmentObject private var lock: AppLock
    @EnvironmentObject private var push: PushRegistrar
    @State private var scanning = false
    @State private var cameraUnavailable = false
    @State private var typing = false

    let endReason: PairingEndReason?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch flow.step {
            case .idle, .done:
                scanStep
            case .confirm(let code, let name):
                confirmStep(code: code, computerName: name)
            case .waitingForApproval(let code):
                waitingStep(code: code)
            case .failed(let message):
                failedStep(message)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.background.ignoresSafeArea())
        .sheet(isPresented: $typing) { CodeEntryView() }
    }

    private var scanStep: some View {
        Group {
            Text("Pair with your computer")
                .font(.title2.weight(.semibold))
                .foregroundStyle(Theme.text)
            if let endReason {
                Text(endReason.message)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            Text("On your computer, open Girru, then Settings › Phone. A code appears there.")
                .foregroundStyle(Theme.secondaryText)

            ZStack {
                RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.black.opacity(0.85))
                if scanning && !cameraUnavailable {
                    QRScannerView(onCode: { text in
                        scanning = false
                        flow.scanned(text, context: lock.context)
                    }, onUnavailable: { cameraUnavailable = true })
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                } else {
                    Text(cameraUnavailable ? "Girru cannot use the camera. Allow it in Settings, or type the code." : "Point the camera at the code")
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.white)
                        .padding()
                }
            }
            .aspectRatio(1, contentMode: .fit)

            Spacer(minLength: 0)
            Button("Scan the code") { cameraUnavailable = false; scanning = true }
                .buttonStyle(PrimaryButtonStyle())
            Button("Type the code instead") { typing = true }
                .frame(maxWidth: .infinity)
                .foregroundStyle(Theme.accent)
            Text("Your chats stay on your computer. You approve this phone there.")
                .font(.footnote)
                .foregroundStyle(Theme.secondaryText)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
        }
    }

    private func confirmStep(code: String, computerName: String?) -> some View {
        Group {
            Text("Check the code")
                .font(.title2.weight(.semibold))
                .foregroundStyle(Theme.text)
            Text("Your computer\(computerName.map { " (\($0))" } ?? "") shows the same code:")
                .foregroundStyle(Theme.secondaryText)
            codeText(code)

            Text("Stay paired without use for")
                .font(.headline)
                .foregroundStyle(Theme.text)
                .padding(.top, 8)
            Picker("Stay paired without use for", selection: $flow.lifetime) {
                ForEach(PairingLifetime.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            .pickerStyle(.menu)
            Text(flow.lifetime.warning ?? "Each use starts the time again, so you do not scan again while you use Girru.")
                .font(.footnote)
                .foregroundStyle(flow.lifetime.warning == nil ? Theme.secondaryText : Color.orange)

            Spacer(minLength: 0)
            Button("Send to my computer") {
                flow.send(phoneName: UIDevice.current.name, pushToken: push.token) { model.didPair($0) }
            }
            .buttonStyle(PrimaryButtonStyle())
            Button("Cancel") { flow.reset() }
                .frame(maxWidth: .infinity)
                .foregroundStyle(Theme.accent)
        }
    }

    private func waitingStep(code: String) -> some View {
        Group {
            Text("Approve this phone on your computer")
                .font(.title2.weight(.semibold))
                .foregroundStyle(Theme.text)
            Text("Check that your computer shows this code, then click Approve there.")
                .foregroundStyle(Theme.secondaryText)
            codeText(code)
            ProgressView().frame(maxWidth: .infinity)
            Spacer(minLength: 0)
            Button("Cancel") { flow.reset() }
                .frame(maxWidth: .infinity)
                .foregroundStyle(Theme.accent)
        }
    }

    private func failedStep(_ message: String) -> some View {
        Group {
            Text("Pairing did not finish")
                .font(.title2.weight(.semibold))
                .foregroundStyle(Theme.text)
            Text(message).foregroundStyle(Theme.secondaryText)
            Spacer(minLength: 0)
            Button("Try again") { flow.reset() }
                .buttonStyle(PrimaryButtonStyle())
        }
    }

    private func codeText(_ code: String) -> some View {
        Text("\(code.prefix(3)) \(code.suffix(3))")
            .font(.system(size: 40, weight: .semibold, design: .monospaced))
            .foregroundStyle(Theme.text)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .accessibilityLabel(code.map(String.init).joined(separator: " "))
    }
}

/// "Type the code instead". PROTOCOL.md has no typed-code exchange yet, so the
/// sheet checks the form and says plainly that scanning is needed for now.
struct CodeEntryView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("ABCD-EFGH-JKMN", text: $text)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.system(.title3, design: .monospaced))
                } footer: {
                    Text(message ?? "The code is under the QR code on your computer.")
                }
            }
            .navigationTitle("Type the code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Continue") {
                        if PairingCode.normalize(text) == nil {
                            message = "This code has 12 letters and numbers. Check it and try again."
                        } else {
                            message = "Typing the code is not ready yet. Scan the code on your computer instead."
                        }
                    }
                }
            }
        }
    }
}
