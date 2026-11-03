import Foundation
import WebKit

/// One response from the computer for a core-ui request.
struct CoreUIResponse: Sendable {
    var status: Int
    var headers: [String: String]
    var body: Data
}

/// Fetches core-ui files and API calls from the paired computer through the
/// authenticated g1 session (local, direct or relay). Built with MOB-LINK-01.
protocol CoreUISource: Sendable {
    func fetch(method: String, path: String, headers: [String: String], body: Data?) async throws -> CoreUIResponse
}

/// Until the session exists: a plain page that says so. Never falls back to
/// loading anything over the network.
struct UnavailableCoreUISource: CoreUISource {
    func fetch(method: String, path: String, headers: [String: String], body: Data?) async throws -> CoreUIResponse {
        let html = """
        <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body{font-family:-apple-system,system-ui,sans-serif;padding:48px 24px;color:#252528;background:#F8F9FE}
        @media (prefers-color-scheme: dark){body{color:#F2F3F7;background:#1B1F27}}</style>
        <h2>Cannot reach your computer yet</h2><p>This version of Girru cannot connect to your computer yet.</p>
        """
        return CoreUIResponse(status: 503, headers: ["Content-Type": "text/html; charset=utf-8"], body: Data(html.utf8))
    }
}

/// The only way core-ui reaches the web view: `girru-app://computer/...`
/// requests are answered here, never by the network.
final class CoreUISchemeHandler: NSObject, WKURLSchemeHandler {
    private let source: CoreUISource
    /// Tasks WebKit has stopped; answering them would crash.
    private var stopped = Set<ObjectIdentifier>()

    init(source: CoreUISource) { self.source = source }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let request = task.request
        guard let url = request.url, CoreUIOrigin.contains(url) else {
            task.didFailWithError(URLError(.unsupportedURL))
            return
        }
        let id = ObjectIdentifier(task)
        let method = request.httpMethod ?? "GET"
        var path = url.path.isEmpty ? "/" : url.path
        if let q = url.query { path += "?\(q)" }
        let headers = request.allHTTPHeaderFields ?? [:]
        let body = request.httpBody
        let source = self.source
        Task { @MainActor in
            let result: Result<CoreUIResponse, Error>
            do { result = .success(try await source.fetch(method: method, path: path, headers: headers, body: body)) } catch { result = .failure(error) }
            guard !self.stopped.contains(id) else { self.stopped.remove(id); return }
            switch result {
            case .success(let r):
                var h = r.headers
                // core-ui runs with no network access of its own.
                h["Content-Security-Policy"] = h["Content-Security-Policy"] ?? "default-src 'self' girru-app:; img-src 'self' girru-app: data: blob:; style-src 'self' girru-app: 'unsafe-inline'; connect-src 'self' girru-app:"
                guard let response = HTTPURLResponse(url: url, statusCode: r.status, httpVersion: "HTTP/1.1", headerFields: h) else {
                    task.didFailWithError(URLError(.badServerResponse))
                    return
                }
                task.didReceive(response)
                task.didReceive(r.body)
                task.didFinish()
            case .failure(let error):
                task.didFailWithError(error)
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }
}
