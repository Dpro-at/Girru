import SwiftUI
import UIKit

/// Board P2: the app never opens straight in.
struct UnlockView: View {
    @EnvironmentObject private var lock: AppLock
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Text("Girru is locked")
                .font(.title2.weight(.semibold))
                .foregroundStyle(Theme.text)
            if let name = model.computer?.computerName {
                Text(name)
                    .font(.subheadline)
                    .foregroundStyle(Theme.secondaryText)
            }
            Image(systemName: symbol)
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(Theme.accent)
                .padding(.vertical, 24)
                .accessibilityHidden(true)

            if lock.state == .needsPasscode {
                Text("Set a passcode on this iPhone to use Girru. Girru keeps its keys behind it.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Theme.secondaryText)
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                .buttonStyle(PrimaryButtonStyle())
            } else {
                if let error = lock.lastError {
                    Text(error).font(.footnote).foregroundStyle(Theme.secondaryText)
                }
                Spacer()
                Button("Unlock with \(lock.biometryName)") { Task { await lock.unlock() } }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(lock.state == .unlocking)
                // Same system check; iOS offers the passcode after a failed or
                // cancelled Face ID, so this is the obvious way there.
                Button("Use passcode") { Task { await lock.unlock() } }
                    .foregroundStyle(Theme.accent)
                    .disabled(lock.state == .unlocking)
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background.ignoresSafeArea())
        .task { await lock.unlock() }
    }

    private var symbol: String {
        switch lock.biometryName {
        case "Face ID": return "faceid"
        case "Touch ID": return "touchid"
        case "Optic ID": return "opticid"
        default: return "lock.fill"
        }
    }
}

/// Covers the app in the app switcher and whenever the scene is not active.
struct PrivacyCover: View {
    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            Image(systemName: "lock.fill")
                .font(.system(size: 40))
                .foregroundStyle(Theme.secondaryText)
                .accessibilityLabel("Girru")
        }
    }
}
