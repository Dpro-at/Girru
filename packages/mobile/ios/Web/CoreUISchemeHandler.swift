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
/// One piece of a streamed answer, in order.
enum StreamPiece: Sendable {
    case start(status: Int, headers: [String: String])
    case data(Data)
}

protocol CoreUISource: Sendable {
    func fetch(method: String, path: String, headers: [String: String], body: Data?) async throws -> CoreUIResponse
    /// A run's live events (`/api/chat/runs/<id>/events`): one `start`, then the
    /// event stream's pieces; it finishes at the stream's end.
    func stream(path: String) -> AsyncThrowingStream<StreamPiece, Error>
}

extension CoreUISource {
    func stream(path: String) -> AsyncThrowingStream<StreamPiece, Error> {
        AsyncThrowingStream { c in
            Task {
                do {
                    let r = try await fetch(method: "GET", path: path, headers: [:], body: nil)
                    c.yield(.start(status: r.status, headers: r.headers))
                    c.yield(.data(r.body))
                    c.finish()
                } catch { c.finish(throwing: error) }
            }
        }
    }
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
        // WebKit hands a fetch() body over as a stream more often than as data.
        let body = request.httpBody ?? Self.read(request.httpBodyStream, limit: PageBridge.maxBody + 1)
        let source = self.source
        if method == "GET", case .stream = PageBridge.classify(method: method, path: path) {
            startStream(task, id: id, url: url, path: path)
            return
        }
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

    private static func read(_ stream: InputStream?, limit: Int) -> Data? {
        guard let stream else { return nil }
        stream.open()
        defer { stream.close() }
        var out = Data()
        var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        while stream.hasBytesAvailable && out.count <= limit {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            out.append(buffer, count: n)
        }
        return out
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }

    /// Streams a run's events into the page as they come; the page reads them like the desktop's event stream.
    private func startStream(_ task: WKURLSchemeTask, id: ObjectIdentifier, url: URL, path: String) {
        let pieces = source.stream(path: path)
        Task { @MainActor in
            var started = false
            // An event can arrive just before the reply that starts the stream: keep it until then.
            var early: [Data] = []
            do {
                for try await piece in pieces {
                    if self.stopped.contains(id) { self.stopped.remove(id); return }
                    switch piece {
                    case let .start(status, headers):
                        guard !started, let r = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else { continue }
                        started = true
                        task.didReceive(r)
                        early.forEach { task.didReceive($0) }
                        early.removeAll()
                    case let .data(data):
                        if started { task.didReceive(data) } else if early.count < 256 { early.append(data) }
                    }
                }
                if self.stopped.contains(id) { self.stopped.remove(id); return }
                if started { task.didFinish() } else { task.didFailWithError(URLError(.badServerResponse)) }
            } catch {
                if self.stopped.contains(id) { self.stopped.remove(id); return }
                if started { task.didFinish() } else { task.didFailWithError(error) }
            }
        }
    }
}
