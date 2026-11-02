import SwiftUI

/// Lock first, always; then pairing or the computer's screens. Content is
/// covered whenever the scene is not active, so the app switcher shows nothing.
struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var lock: AppLock
    @EnvironmentObject private var bridge: WebBridge
    @Environment(\.scenePhase) private var phase
    @State private var hasUnlocked = false

    var body: some View {
        ZStack {
            if hasUnlocked {
                content
                    .accessibilityHidden(!lock.isUnlocked)
                    .allowsHitTesting(lock.isUnlocked)
            }
            if !lock.isUnlocked {
                UnlockView()
            }
            if phase != .active {
                PrivacyCover()
            }
        }
        .onChange(of: phase) { _, newPhase in
            switch newPhase {
            case .background:
                lock.didEnterBackground()
            case .active:
                lock.willEnterForeground()
                model.refreshPairing()
            default:
                break
            }
        }
        .onChange(of: lock.state) { _, state in
            guard state == .unlocked else { return }
            hasUnlocked = true
            Task { await model.sendPendingDecision() }
        }
        .sheet(isPresented: Binding(get: { bridge.scannerOpen }, set: { if !$0 { bridge.finishScan(nil) } })) {
            ScannerSheet { bridge.finishScan($0) }
        }
        .overlay(alignment: .bottom) {
            if let notice = model.notice {
                Text(notice)
                    .font(.subheadline)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.thinMaterial, in: Capsule())
                    .padding(.bottom, 24)
                    .onTapGesture { model.notice = nil }
                    .task {
                        try? await Task.sleep(for: .seconds(4))
                        model.notice = nil
                    }
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch model.pairing {
        case .paired(let computer):
            WebHostView(computer: computer, bridge: bridge)
                .ignoresSafeArea(.container, edges: .bottom)
        case .notPaired:
            PairingView(endReason: nil)
        case .ended(let reason):
            PairingView(endReason: reason)
        }
    }
}
