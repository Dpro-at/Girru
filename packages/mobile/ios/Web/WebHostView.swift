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

    static var fallbackPage: URL? { Bundle.main.url(forResource: "NotPaired", withExtension: "html") }

    func makeCoordinator() -> Coordinator {
        Coordinator(policy: NavigationPolicy(paired: computer != nil, fallbackPage: Self.fallbackPage), bridge: bridge)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // Nothing from the chats is cached on the phone; it stays on the computer.
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.setURLSchemeHandler(CoreUISchemeHandler(source: source), forURLScheme: CoreUIOrigin.scheme)

        let content = WKUserContentController()
        content.addScriptMessageHandler(WeakReplyHandler(context.coordinator), contentWorld: .page, name: "girru")
        // Lets core-ui pick the phone layout and know the bridge exists.
        content.addUserScript(WKUserScript(source: "window.girruShell = Object.freeze({ platform: 'ios', bridge: 1 });",
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
        context.coordinator.watchTerminal(web)
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

        deinit { if let terminalWatch { NotificationCenter.default.removeObserver(terminalWatch) } }

        /// Failed loads in a row; the page is tried again with a growing pause until it loads.
        private var failedLoads = 0

        /// The chat page could not load (for example the session dropped while it opened): try again
        /// after 2, 4, 8, 16, then every 30 seconds, while this phone is still paired and nothing else loaded.
        private func retryLater(_ web: WKWebView, after error: Error) {
            guard policy.paired, (error as NSError).code != NSURLErrorCancelled else { return }
            failedLoads += 1
            let seconds = min(30.0, pow(2.0, Double(min(failedLoads, 5))))
            Task { @MainActor [weak self, weak web] in
                try? await Task.sleep(for: .seconds(seconds))
                guard let self, let web, self.policy.paired, !web.isLoading else { return }
                let shown = web.url?.absoluteString ?? ""
                guard shown.isEmpty || shown == "about:blank" || self.failedLoads > 0 else { return }
                self.load(in: web)
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            retryLater(webView, after: error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            retryLater(webView, after: error)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            failedLoads = 0
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
        case .openSettings:
            NotificationCenter.default.post(name: .girruOpenSettings, object: nil)
            return ["ok": true]
        }
    }

    func finishScan(_ text: String?) {
        scannerOpen = false
        scanContinuation?.resume(returning: text)
        scanContinuation = nil
    }
}
