import Combine
import SwiftUI
import UIKit
import WebKit

/// Hosts the computer's core-ui screens. They load only from
/// `girru-app://computer/`, which the app answers itself through the g1
/// session; http and https never load inside the app, and the bridge answers
/// only that origin.
struct WebHostView: UIViewRepresentable {
    let computer: PairedComputer?
    let bridge: WebBridge
    var source: CoreUISource = UnavailableCoreUISource()
    /// Which computer page this view shows: nil = the chat, "board" = Tasks › Board (phone board P46).
    var page: String? = nil

    static var fallbackPage: URL? { Bundle.main.url(forResource: "NotPaired", withExtension: "html") }

    func makeCoordinator() -> Coordinator {
        Coordinator(policy: NavigationPolicy(paired: computer != nil, fallbackPage: Self.fallbackPage), bridge: bridge)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // Nothing from the chats is cached on the phone; it stays on the computer.
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        // The meeting call shows the camera preview inside the page (board P42), not full screen.
        config.allowsInlineMediaPlayback = true
        config.setURLSchemeHandler(CoreUISchemeHandler(source: source), forURLScheme: CoreUIOrigin.scheme)

        let content = WKUserContentController()
        content.addScriptMessageHandler(WeakReplyHandler(context.coordinator), contentWorld: .page, name: "girru")
        // Lets core-ui pick the phone layout and know the bridge exists.
        let pagePart = page == "board" ? ", page: 'board'" : ""
        content.addUserScript(WKUserScript(source: "window.girruShell = Object.freeze({ platform: 'ios', bridge: 1\(pagePart) });",
                                           injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = content

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsLinkPreview = false
        web.allowsBackForwardNavigationGestures = false
        #if DEBUG
        web.isInspectable = true
        #endif
        context.coordinator.load(in: web)
        if page == nil { context.coordinator.watchTerminal(web); context.coordinator.watchChatLinks(web) }
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        let paired = computer != nil
        if paired != context.coordinator.policy.paired {
            context.coordinator.policy = NavigationPolicy(paired: paired, fallbackPage: Self.fallbackPage)
            context.coordinator.load(in: web)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
        var policy: NavigationPolicy
        let bridge: WebBridge

        init(policy: NavigationPolicy, bridge: WebBridge) {
            self.policy = policy
            self.bridge = bridge
        }

        private var terminalWatch: NSObjectProtocol?

        /// The terminal button (after its fingerprint check) asks the page to open its terminal.
        func watchTerminal(_ web: WKWebView) {
            terminalWatch = NotificationCenter.default.addObserver(forName: .girruOpenTerminal, object: nil, queue: .main) { [weak web, weak self] _ in
                guard let web, self?.policy.paired == true else { return }
                web.evaluateJavaScript("location.hash = 'terminal'")
            }
        }

        private var chatWatch: NSObjectProtocol?

        /// A chat opened from Tasks › Board: the chat page opens it from `#chat=<id>`.
        func watchChatLinks(_ web: WKWebView) {
            chatWatch = NotificationCenter.default.addObserver(forName: .girruOpenChat, object: nil, queue: .main) { [weak web, weak self] note in
                guard let web, self?.policy.paired == true, let id = note.object as? String, BridgeMessageParser.isChatId(id) else { return }
                web.evaluateJavaScript("location.hash = 'chat=\(id)'")
            }
        }

        deinit {
            if let terminalWatch { NotificationCenter.default.removeObserver(terminalWatch) }
            if let chatWatch { NotificationCenter.default.removeObserver(chatWatch) }
        }

        /// Phone board P42: the meeting page may use the microphone and camera, only the paired page in
        /// the main frame and only while the app is unlocked. iOS asks the person once on first use.
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            let unlocked = MainActor.assumeIsolated { bridge.unlocked }
            let ok = policy.paired && frame.isMainFrame && unlocked
                && BridgeGate.allowsOrigin(scheme: origin.protocol, host: origin.host, isMainFrame: true)
            decisionHandler(ok ? .grant : .deny)
        }

        func load(in web: WKWebView) {
            if policy.paired {
                web.load(URLRequest(url: CoreUIOrigin.startURL))
            } else if let page = WebHostView.fallbackPage {
                web.loadFileURL(page, allowingReadAccessTo: page)
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.cancel) }
            let decision = policy.decide(url, isMainFrame: action.targetFrame?.isMainFrame ?? true, userInitiated: action.navigationType == .linkActivated)
            switch decision {
            case .allow:
                decisionHandler(.allow)
            case .openExternally:
                decisionHandler(.cancel)
                UIApplication.shared.open(url)
            case .deny:
                decisionHandler(.cancel)
            }
        }

        /// target="_blank" and window.open: never a second web view.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url, policy.decide(url, isMainFrame: true, userInitiated: action.navigationType == .linkActivated) == .openExternally {
                UIApplication.shared.open(url)
            }
            return nil
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
            let origin = message.frameInfo.securityOrigin
            guard policy.paired, BridgeGate.allowsOrigin(scheme: origin.protocol, host: origin.host, isMainFrame: message.frameInfo.isMainFrame) else {
                return replyHandler(nil, "not allowed")
            }
            let request: BridgeRequest
            do { request = try BridgeMessageParser.parse(message.body) } catch { return replyHandler(nil, "bad request") }
            Task { @MainActor in
                if let reply = await bridge.handle(request) {
                    replyHandler(reply, nil)
                } else {
                    replyHandler(nil, "locked")
                }
            }
        }
    }
}

/// WKUserContentController keeps its handlers strongly; this breaks the cycle.
private final class WeakReplyHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: WKScriptMessageHandlerWithReply?
    init(_ target: WKScriptMessageHandlerWithReply) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let target else { return replyHandler(nil, "gone") }
        target.userContentController(c, didReceive: m, replyHandler: replyHandler)
    }
}

/// Native answers to the four bridge requests. While the app is locked only
/// `lock.state` is answered; locking closes the scanner.
@MainActor
final class WebBridge: ObservableObject {
    @Published private(set) var scannerOpen = false
    private var scanContinuation: CheckedContinuation<String?, Never>?
    private let lock: AppLock
    private let push: PushRegistrar
    private var lockWatch: AnyCancellable?

    /// True while the app is unlocked (the page's microphone and camera are allowed only then).
    var unlocked: Bool { lock.isUnlocked }

    init(lock: AppLock, push: PushRegistrar) {
        self.lock = lock
        self.push = push
        lockWatch = lock.$state.sink { [weak self] state in
            if state != .unlocked { self?.finishScan(nil) }
        }
    }

    /// nil = refused because the app is locked.
    func handle(_ request: BridgeRequest) async -> [String: Any]? {
        guard BridgeGate.allows(request, unlocked: lock.isUnlocked) else { return nil }
        switch request {
        case .lockState:
            return ["locked": !lock.isUnlocked, "relockDelay": lock.policy.relockDelay]
        case .authenticate(let reason):
            return ["ok": await lock.confirmSensitive(reason: reason) != nil]
        case .scanQR:
            guard scanContinuation == nil else { return ["cancelled": true] }
            let text = await withCheckedContinuation { (c: CheckedContinuation<String?, Never>) in
                scanContinuation = c
                scannerOpen = true
            }
            // A lock while scanning ends the scan with nothing.
            guard lock.isUnlocked else { return nil }
            return text.map { ["text": $0] } ?? ["cancelled": true]
        case .pushPermission(let ask):
            return ["status": await push.refresh(ask: ask)]
        case .openChat(let id):
            // MainTabs switches to Chat; the chat view opens the conversation.
            NotificationCenter.default.post(name: .girruOpenChat, object: id)
            return ["ok": true]
        }
    }

    func finishScan(_ text: String?) {
        scannerOpen = false
        scanContinuation?.resume(returning: text)
        scanContinuation = nil
    }
}
