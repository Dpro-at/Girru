import Foundation

/// The computer's chat page inside the app (PROTOCOL.md "The computer's pages on
/// the phone"): turns the web view's `girru-app://computer/…` requests into the
/// signed commands `ui.get`, `api.call` and `api.stream`, and their answers back
/// into what the page reads. No network, no token: the computer runs each
/// request as the owner.
public enum PageRequest: Equatable, Sendable {
    /// A file of the built page (`ui.get`).
    case file(path: String)
    /// One API request (`api.call`).
    case api(method: String, path: String)
    /// A run's live events (`api.stream`).
    case stream(path: String)
    /// Answered here without asking the computer.
    case refuse(status: Int)
}

/// One answer for the web view.
public struct PageResponse: Sendable, Equatable {
    public var status: Int
    public var headers: [String: String]
    public var body: Data

    public init(status: Int, headers: [String: String], body: Data) {
        self.status = status
        self.headers = headers
        self.body = body
    }
}

public enum PageBridge {
    static let methods: Set<String> = ["GET", "POST", "PUT", "PATCH", "DELETE"]
    /// The largest request body the computer takes (`api.call`).
    public static let maxBody = 256 * 1024
    /// The most parts one file may have (40 MiB build limit / 600 KiB per part).
    static let maxParts = 70

    public static func classify(method: String, path: String) -> PageRequest {
        let m = method.uppercased()
        guard methods.contains(m), path.hasPrefix("/"), path.utf8.count <= 2048 else { return .refuse(status: 400) }
        if path.hasPrefix("/api/") {
            if m == "GET" && isEvents(path) { return .stream(path: path) }
            return .api(method: m, path: path)
        }
        guard m == "GET" else { return .refuse(status: 405) }
        // Query strings never name a page file.
        let file = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? path
        return .file(path: file)
    }

    /// `/api/chat/runs/<runId>/events[?after=N]`
    static func isEvents(_ path: String) -> Bool {
        let base = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
        let parts = base.split(separator: "/", omittingEmptySubsequences: false)
        return parts.count == 6 && parts[1] == "api" && parts[2] == "chat" && parts[3] == "runs" && !parts[4].isEmpty && parts[5] == "events"
    }

    /// The request body as JSON, nil when empty. Anything else is refused before it is signed.
    public static func jsonBody(_ data: Data?) throws -> Any? {
        guard let data, !data.isEmpty else { return nil }
        guard data.count <= maxBody else { throw PageError.tooLarge }
        do { return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) } catch { throw PageError.badBody }
    }

    /// The HTTP status the page sees for a refused command.
    public static func status(for code: String) -> Int {
        switch code {
        case "not_allowed": return 403
        case "not_found": return 404
        case "rate_limited": return 429
        case "too_large": return 413
        case "bad_format": return 400
        case "expired", "unknown_device", "revoked", "owner_changed": return 401
        default: return 503
        }
    }

    /// The answer of `api.call`: `{status, body}` with the projected JSON body.
    public static func apiResponse(ok: Bool, data: Any?, error: String?) -> PageResponse {
        guard ok else { return json(status: status(for: error ?? "internal_error"), ["code": error ?? "internal_error"]) }
        guard let d = data as? [String: Any], let status = (d["status"] as? NSNumber)?.intValue, (100...599).contains(status) else {
            return json(status: 502, NSNull())
        }
        return json(status: status, d["body"] ?? NSNull())
    }

    static func json(status: Int, _ value: Any) -> PageResponse {
        let body = (try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])) ?? Data("null".utf8)
        return PageResponse(status: status, headers: ["Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"], body: body)
    }

    /// One `ui.get` answer. `build` must match the first part's.
    public struct FilePart: Equatable, Sendable {
        public var status: Int
        public var type: String
        public var parts: Int
        public var part: Int
        public var size: Int
        public var build: String
        public var body: Data
    }

    public static func filePart(_ data: Any?) throws -> FilePart {
        guard let d = data as? [String: Any], let status = (d["status"] as? NSNumber)?.intValue else { throw PageError.badAnswer }
        let build = d["build"] as? String ?? ""
        if status != 200 { return FilePart(status: status, type: "", parts: 0, part: 0, size: 0, build: build, body: Data()) }
        guard let type = d["type"] as? String, let parts = (d["parts"] as? NSNumber)?.intValue, let part = (d["part"] as? NSNumber)?.intValue,
              let size = (d["size"] as? NSNumber)?.intValue, let b64 = d["body"] as? String, let body = Data(base64Encoded: b64),
              (1...maxParts).contains(parts), (0..<parts).contains(part), !build.isEmpty else { throw PageError.badAnswer }
        return FilePart(status: 200, type: type, parts: parts, part: part, size: size, build: build, body: body)
    }

    /// Puts a file's parts together; they must be complete, in order, of one build and of the stated size.
    public static func assemble(_ parts: [FilePart]) throws -> PageResponse {
        guard let first = parts.first else { throw PageError.badAnswer }
        if first.status != 200 { return PageResponse(status: first.status, headers: ["Content-Type": "text/plain; charset=utf-8"], body: Data()) }
        guard parts.count == first.parts else { throw PageError.badAnswer }
        var body = Data()
        for (i, p) in parts.enumerated() {
            guard p.part == i, p.build == first.build, p.parts == first.parts, p.type == first.type, p.size == first.size else { throw PageError.badAnswer }
            body.append(p.body)
        }
        guard body.count == first.size else { throw PageError.badAnswer }
        return PageResponse(status: 200, headers: ["Content-Type": first.type, "Cache-Control": "no-store"], body: body)
    }

    /// One stream event as the page's event stream reads it: `id: <seq>` (when numbered) and `data: <json>`.
    public static func sse(_ data: [String: Any]) -> Data {
        var out = ""
        if let seq = (data["seq"] as? NSNumber)?.intValue, seq > 0 { out += "id: \(seq)\n" }
        let json = (try? JSONSerialization.data(withJSONObject: data, options: [.sortedKeys])) ?? Data("{}".utf8)
        out += "data: \(String(decoding: json, as: UTF8.self))\n\n"
        return Data(out.utf8)
    }

    public static let streamHeaders = ["Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store"]
}

public enum PageError: Error, Equatable {
    case badBody
    case tooLarge
    case badAnswer
}
