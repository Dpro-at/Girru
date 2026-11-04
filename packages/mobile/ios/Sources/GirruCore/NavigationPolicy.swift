import Foundation

/// core-ui is never loaded over the network by the web view. Every request to
/// this origin is answered by the app's scheme handler, which fetches it from
/// the computer through the authenticated g1 session. Nobody else on the
/// network can serve a page under it.
public enum CoreUIOrigin {
    public static let scheme = "girru-app"
    public static let host = "computer"
    public static let startURL = URL(string: "girru-app://computer/")!

    public static func contains(_ url: URL) -> Bool {
        url.scheme?.lowercased() == scheme && url.host?.lowercased() == host && url.port == nil
            && url.user == nil && url.password == nil
    }
}

public enum NavigationDecision: Equatable, Sendable {
    case allow
    /// Hand to Safari (or the Phone / Mail app) and keep the web view where it is.
    case openExternally
    case deny
}

/// Keeps the web host on core-ui from the paired computer only.
public struct NavigationPolicy: Sendable {
    /// False until a computer is paired: then only the bundled page loads.
    public let paired: Bool
    /// The bundled "Not paired yet" page.
    public let fallbackPage: URL?

    public init(paired: Bool, fallbackPage: URL?) {
        self.paired = paired
        self.fallbackPage = fallbackPage
    }

    /// - Parameter userInitiated: true for a tap on a link. Scripted jumps to
    ///   other sites are dropped rather than opened, so a page cannot push the
    ///   owner out of the app on its own.
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
        if scheme == CoreUIOrigin.scheme {
            return paired && CoreUIOrigin.contains(url) ? .allow : .deny
        }
        // http and https never load inside the app, in any frame: a page on
        // the local network could otherwise reach the bridge.
        if scheme == "http" || scheme == "https" {
            return userInitiated && isMainFrame && url.host != nil ? .openExternally : .deny
        }
        if scheme == "mailto" || scheme == "tel" {
            return userInitiated ? .openExternally : .deny
        }
        return .deny
    }
}
