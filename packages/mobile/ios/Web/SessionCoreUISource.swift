import Foundation

/// The computer's chat page through the session (PROTOCOL.md "The computer's
/// pages on the phone"): page files with `ui.get`, the page's requests with
/// `api.call`, a run's live events with `api.stream`. Nothing goes to the
/// network and no token is sent; while the app is locked nothing is signed.
struct SessionCoreUISource: CoreUISource {
    /// Signs one command body behind the app lock and sends it (AppModel.send).
    let send: @Sendable (_ body: String, _ stream: (@Sendable (StreamEvent) -> Void)?) async throws -> CommandReply

    func fetch(method: String, path: String, headers: [String: String], body: Data?) async throws -> CoreUIResponse {
        switch PageBridge.classify(method: method, path: path) {
        case .refuse(let status):
            return CoreUIResponse(status: status, headers: [:], body: Data())
        case .file(let file):
            return try await page(file)
        case .api(let m, let p):
            let json: Any?
            do { json = try PageBridge.jsonBody(body) } catch PageError.tooLarge { return response(PageBridge.json(status: 413, ["code": "too_large"])) }
            let r = try await send(try CommandBody.apiCall(method: m, path: p, body: json, ref: Self.ref()), nil)
            return response(PageBridge.apiResponse(ok: r.ok, data: r.data, error: r.error))
        case .stream:
            // Streams go through stream(path:).
            return CoreUIResponse(status: 400, headers: [:], body: Data())
        }
    }

    func stream(path: String) -> AsyncThrowingStream<StreamPiece, Error> {
        AsyncThrowingStream { c in
            // The reply and the stream's frames come in order on the wire, but the
            // reply wakes this task later than the frames reach the handler.
            let gate = StreamGate(c)
            let task = Task {
                do {
                    let r = try await send(try CommandBody.apiStream(path: path, ref: Self.ref()), { event in
                        switch event {
                        case .data(let d): c.yield(.data(PageBridge.sse(d)))
                        // A dropped stream just ends; the page re-attaches with after=<last seq>.
                        case .end: gate.end()
                        }
                    })
                    if r.ok {
                        gate.start(.start(status: 200, headers: PageBridge.streamHeaders))
                    } else {
                        let a = PageBridge.apiResponse(ok: false, data: nil, error: r.error)
                        c.yield(.start(status: a.status, headers: a.headers))
                        c.yield(.data(a.body))
                        c.finish()
                    }
                } catch { c.finish(throwing: error) }
            }
            c.onTermination = { _ in task.cancel() }
        }
    }

    /// Every part of one file, of one build.
    private func page(_ path: String) async throws -> CoreUIResponse {
        var parts: [PageBridge.FilePart] = []
        repeat {
            let r = try await send(try CommandBody.uiGet(path: path, part: parts.count, ref: Self.ref()), nil)
            guard r.ok else { return response(PageBridge.apiResponse(ok: false, data: nil, error: r.error)) }
            let part = try PageBridge.filePart(r.data)
            parts.append(part)
            if part.status != 200 { break }
        } while parts.count < parts[0].parts
        return response(try PageBridge.assemble(parts))
    }

    private func response(_ r: PageResponse) -> CoreUIResponse {
        CoreUIResponse(status: r.status, headers: r.headers, body: r.body)
    }

    private static func ref() -> String { "p" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(20) }
}

/// Finishes the page's stream only after it started, whichever comes first.
private final class StreamGate: @unchecked Sendable {
    private let c: AsyncThrowingStream<StreamPiece, Error>.Continuation
    private let lock = NSLock()
    private var started = false
    private var ended = false

    init(_ c: AsyncThrowingStream<StreamPiece, Error>.Continuation) { self.c = c }

    func start(_ piece: StreamPiece) {
        lock.lock(); defer { lock.unlock() }
        started = true
        c.yield(piece)
        if ended { c.finish() }
    }

    func end() {
        lock.lock(); defer { lock.unlock() }
        ended = true
        if started { c.finish() }
    }
}
