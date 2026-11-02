import Foundation

public struct WebOrigin: Equatable, Hashable, Sendable {
    public let scheme: String
    public let host: String
    public let port: Int

    public init?(url: URL) {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        self.scheme = scheme
        self.host = host
        self.port = url.port ?? (scheme == "https" ? 443 : 80)
    }
}

public enum NavigationDecision: Equatable, Sendable {
    case allow
    /// Hand to Safari (or the Phone / Mail app) and keep the web view where it is.
    case openExternally
    case deny
}

/// Keeps the web host on the paired computer's pages only.
public struct NavigationPolicy: Sendable {
    public let pairedOrigin: WebOrigin?
    /// The bundled "Not paired yet" page.
    public let fallbackPage: URL?

    public init(pairedOrigin: WebOrigin?, fallbackPage: URL?) {
        self.pairedOrigin = pairedOrigin
        self.fallbackPage = fallbackPage
    }

    /// - Parameter userInitiated: true for a tap on a link. Scripted redirects
    ///   to other sites are dropped rather than opened, so a page cannot push
    ///   the owner out of the app on its own.
    public func decide(_ url: URL, isMainFrame: Bool, userInitiated: Bool) -> NavigationDecision {
        let scheme = url.scheme?.lowercased() ?? ""

        if scheme == "about" {
            return url.absoluteString == "about:blank" || url.absoluteString == "about:srcdoc" ? .allow : .deny
        }
        if scheme == "file" {
            guard let fallback = fallbackPage, isMainFrame,
                  url.standardizedFileURL.path == fallback.standardizedFileURL.path else { return .deny }
            return .allow
        }
        if let origin = WebOrigin(url: url) {
            if origin == pairedOrigin { return .allow }
            // Other sites never load inside the app, in any frame.
            return userInitiated && isMainFrame ? .openExternally : .deny
        }
        if scheme == "mailto" || scheme == "tel" {
            return userInitiated ? .openExternally : .deny
        }
        return .deny
    }
}
