import SwiftUI
import UIKit
import WebKit

/// Hosts the computer's core-ui screens. Only the paired computer's pages load
/// here; other links open in Safari, scripted jumps elsewhere are dropped.
struct WebHostView: UIViewRepresentable {
    let computer: PairedComputer?
    let bridge: WebBridge

    static var fallbackPage: URL? { Bundle.main.url(forResource: "NotPaired", withExtension: "html") }

    func makeCoordinator() -> Coordinator {
        Coordinator(policy: NavigationPolicy(pairedOrigin: computer?.webURL.flatMap(WebOrigin.init(url:)), fallbackPage: Self.fallbackPage), bridge: bridge)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // Nothing from the chats is cached on the phone; it stays on the computer.
        config.websiteDataStore = .nonPersistent()
        config.limitsNavigationsToAppBoundDomains = false
        config.preferences.javaScriptCanOpenWindowsAutomatically = false

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
        context.coordinator.load(computer: computer, in: web)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        let origin = computer?.webURL.flatMap(WebOrigin.init(url:))
        if origin != context.coordinator.policy.pairedOrigin {
            context.coordinator.policy = NavigationPolicy(pairedOrigin: origin, fallbackPage: Self.fallbackPage)
            context.coordinator.load(computer: computer, in: web)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
        var policy: NavigationPolicy
        let bridge: WebBridge

        init(policy: NavigationPolicy, bridge: WebBridge) {
            self.policy = policy
            self.bridge = bridge
        }

        func load(computer: PairedComputer?, in web: WKWebView) {
            if let url = computer?.webURL, policy.pairedOrigin != nil {
                web.load(URLRequest(url: url))
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
            // Only the paired computer's main frame may talk to the shell.
            let origin = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame, let paired = policy.pairedOrigin,
                  origin.protocol.lowercased() == paired.scheme, origin.host.lowercased() == paired.host,
                  (origin.port == 0 ? (paired.scheme == "https" ? 443 : 80) : origin.port) == paired.port else {
                return replyHandler(nil, "not allowed")
            }
            let request: BridgeRequest
            do { request = try BridgeMessageParser.parse(message.body) } catch { return replyHandler(nil, "bad request") }
            Task { @MainActor in
                let reply = await bridge.handle(request)
                replyHandler(reply, nil)
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

/// Native answers to the four bridge requests.
@MainActor
final class WebBridge: ObservableObject {
    @Published var scannerOpen = false
    private var scanContinuation: CheckedContinuation<String?, Never>?
    private let lock: AppLock
    private let push: PushRegistrar

    init(lock: AppLock, push: PushRegistrar) {
        self.lock = lock
        self.push = push
    }

    func handle(_ request: BridgeRequest) async -> [String: Any] {
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
            return text.map { ["text": $0] } ?? ["cancelled": true]
        case .pushPermission(let ask):
            return ["status": await push.refresh(ask: ask)]
        }
    }

    func finishScan(_ text: String?) {
        scannerOpen = false
        scanContinuation?.resume(returning: text)
        scanContinuation = nil
    }
}
