import Foundation

/// The computer's chat page through the session (PROTOCOL.md "The computer's
/// pages on the phone"): page files with `ui.get`, the page's requests with
/// `api.call`, a run's live events with `api.stream`. Nothing goes to the
/// network and no token is sent; while the app is locked nothing is signed.
struct SessionCoreUISource: CoreUISource {
    /// Signs one command body behind the app lock and sends it (AppModel.send).
    let send: @Sendable (_ body: String, _ stream: (@Sendable (StreamEvent) -> Void)?) async throws -> CommandReply
    /// The terminal opens only after a fresh Face ID / Touch ID / passcode check (the owner's decision).
    let terminal: TerminalGate
    /// Asks for that check; true when it passed.
    let confirm: @Sendable (_ reason: String) async -> Bool

    func fetch(method: String, path: String, headers: [String: String], body: Data?) async throws -> CoreUIResponse {
        switch PageBridge.classify(method: method, path: path) {
        case .refuse(let status):
            return CoreUIResponse(status: status, headers: [:], body: Data())
        case .file(let file):
            return try await page(file)
        case .api(let m, let p):
            guard await terminalAllowed(method: m, path: p) else { return response(PageBridge.json(status: 403, ["code": "forbidden"])) }
            let json: Any?
            do { json = try PageBridge.jsonBody(body) } catch PageError.tooLarge { return response(PageBridge.json(status: 413, ["code": "too_large"])) }
            let r = try await send(try CommandBody.apiCall(method: m, path: p, body: json, ref: Self.ref()), nil)
            // A terminal this phone just opened may be used without asking again.
            if TerminalUse.of(method: m, path: p) == .open, r.ok, let d = r.data as? [String: Any], let body = d["body"] as? [String: Any], let id = body["id"] as? String {
                terminal.add(id)
            }
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
                    guard await terminalAllowed(method: "GET", path: path) else {
                        let a = PageBridge.json(status: 403, ["code": "forbidden"])
                        c.yield(.start(status: a.status, headers: a.headers))
                        c.yield(.data(a.body))
                        c.finish()
                        return
                    }
                    let r = try await send(try CommandBody.apiStream(path: path, ref: Self.ref()), { event in
                        switch event {
                        case let .data(d, event): c.yield(.data(PageBridge.sse(d, event: event)))
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

    private func terminalAllowed(method: String, path: String) async -> Bool {
        switch TerminalUse.of(method: method, path: path) {
        case .none:
            return true
        case .open:
            if terminal.takeFresh() { return true }
            return await confirm("Open the terminal")
        case .session(let id):
            if terminal.knows(id) || terminal.takeFresh() { terminal.add(id); return true }
            guard await confirm("Open the terminal") else { return false }
            terminal.add(id)
            return true
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

/// Which terminals this phone may use without asking again: the ones opened or
/// joined after a check, and anything asked for within a short time after the
/// check the terminal button made. Memory only: a new launch asks again.
final class TerminalGate: @unchecked Sendable {
    private let lock = NSLock()
    private var ids = Set<String>()
    private var freshUntil = Date.distantPast

    /// The terminal button passed its check: the page's next terminal request does not ask again.
    func checked(now: Date = Date()) {
        lock.lock(); defer { lock.unlock() }
        freshUntil = now.addingTimeInterval(30)
    }

    func takeFresh(now: Date = Date()) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard now < freshUntil else { return false }
        return true
    }

    func knows(_ id: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return ids.contains(id)
    }

    func add(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        if ids.count < 32 { ids.insert(id) }
    }

    /// Locking the app forgets every terminal: the next use asks again.
    func forget() {
        lock.lock(); defer { lock.unlock() }
        ids.removeAll()
        freshUntil = .distantPast
    }
}
