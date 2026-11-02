// Checks for GirruCore. `swift run CoreChecks` runs them all and exits non-zero
// on the first failed group. `swift run CoreChecks interop` instead speaks a
// line protocol on stdin/stdout so the computer's reference code can drive a
// real handshake against this implementation (see README).
import CryptoKit
import Foundation
@testable import GirruCore

let crypto = CryptoKitPairingCrypto()
let now = Date(timeIntervalSince1970: 1_800_000_000)
var failures = 0
var passes = 0

func check(_ ok: @autoclosure () throws -> Bool, _ label: String, line: Int = #line) {
    do {
        if try ok() { passes += 1; return }
        print("FAIL line \(line): \(label)")
    } catch {
        print("FAIL line \(line): \(label) threw \(error)")
    }
    failures += 1
}

func fails<E: Error & Equatable>(_ expected: E, _ label: String, line: Int = #line, _ body: () throws -> Void) {
    do {
        try body()
        print("FAIL line \(line): \(label): no error, expected \(expected)")
        failures += 1
    } catch let e as E where e == expected {
        passes += 1
    } catch {
        print("FAIL line \(line): \(label): got \(error), expected \(expected)")
        failures += 1
    }
}

func id32() -> String { Base64URL.encode(crypto.randomBytes(32)) }

// MARK: - base64url

func checkBase64() {
    for n in 0..<40 {
        let d = crypto.randomBytes(n)
        check(Base64URL.decode(Base64URL.encode(d)) == d, "round trip \(n)")
    }
    check(Base64URL.decode("ab+/") == nil, "standard alphabet refused")
    check(Base64URL.decode("abc=") == nil, "padding refused")
    check(Base64URL.decode("a") == nil, "impossible length refused")
    check(Base64URL.decode("AB") == nil, "non-canonical trailing bits refused")
    check(Base64URL.isId(id32()), "32-byte id")
    check(!Base64URL.isId(Base64URL.encode(crypto.randomBytes(31))), "31 bytes is not an id")
}

// MARK: - keys and primitives

func checkCrypto() throws {
    let s = SoftwareIdentitySigner()
    let msg = Data("hello".utf8)
    let sig = try s.sign(msg)
    check(crypto.verify(signature: sig, message: msg, publicKeySPKI: s.publicKeySPKI), "own signature verifies")
    check(!crypto.verify(signature: sig, message: Data("other".utf8), publicKeySPKI: s.publicKeySPKI), "other message refused")
    check(!crypto.verify(signature: sig, message: msg, publicKeySPKI: SoftwareIdentitySigner().publicKeySPKI), "other key refused")
    check(s.publicKeySPKI.count == 91, "P-256 SPKI is 91 bytes")
    check(s.deviceId.count == 43 && Base64URL.isId(s.deviceId), "device id is 43 characters")
    check(crypto.isValidPublicKey(s.publicKeySPKI, expectedId: s.deviceId), "key matches its id")
    check(!crypto.isValidPublicKey(s.publicKeySPKI, expectedId: id32()), "key does not match another id")
    check(!crypto.isValidPublicKey(Data(count: 91), expectedId: nil), "junk key refused")

    let key = crypto.randomBytes(32), nonce = crypto.randomBytes(12)
    let box = try crypto.seal(Data("secret".utf8), key: key, nonce: nonce, aad: Data("aad".utf8))
    check(box.count == 6 + 16, "ciphertext || tag")
    check(try crypto.open(box, key: key, nonce: nonce, aad: Data("aad".utf8)) == Data("secret".utf8), "opens")
    fails(ProtocolError.badTag, "wrong aad") { _ = try crypto.open(box, key: key, nonce: nonce, aad: Data("x".utf8)) }
    var bad = box
    bad[bad.count - 1] ^= 1
    fails(ProtocolError.badTag, "tampered tag") { _ = try crypto.open(bad, key: key, nonce: nonce, aad: Data("aad".utf8)) }
    check(crypto.randomBytes(70).count == 70, "random length")

    // RFC 5869 test case 1, to pin the HKDF wiring.
    let ikm = Data(repeating: 0x0b, count: 22)
    let salt = Data((0x00...0x0c).map { UInt8($0) })
    let info = Data((0xf0...0xf9).map { UInt8($0) })
    let okm = crypto.hkdf(ikm, salt: salt, info: info, count: 42)
    check(okm.map { String(format: "%02x", $0) }.joined() == "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865", "HKDF RFC 5869 case 1")
}

// MARK: - handshake and envelopes

func checkSession() throws {
    let phone = SoftwareIdentitySigner(), computer = SoftwareIdentitySigner()
    let pending = try Handshake.start(signer: phone, peerId: computer.deviceId, crypto: crypto, now: now)
    check(pending.hello.hasPrefix("g1.hs1."), "hs1 prefix")
    let (reply, answerer) = try Handshake.answer(signer: computer, peerSPKI: phone.publicKeySPKI, hello: pending.hello, crypto: crypto, now: now)
    var opener = try Handshake.finish(pending, peerSPKI: computer.publicKeySPKI, reply: reply, crypto: crypto, now: now)
    var answer = answerer
    check(opener.id == answer.id, "same session id")

    let e1 = try opener.seal(Data("from phone".utf8), crypto: crypto)
    check(try answer.open(e1, crypto: crypto) == Data("from phone".utf8), "phone → computer")
    fails(ProtocolError.replay, "replayed envelope") { _ = try answer.open(e1, crypto: crypto) }
    let e2 = try answer.seal(Data("from computer".utf8), crypto: crypto)
    check(try opener.open(e2, crypto: crypto) == Data("from computer".utf8), "computer → phone")

    // Header tamper: change seq inside the header text.
    let e3 = try opener.seal(Data("x".utf8), crypto: crypto)
    let parts = e3.split(separator: ".").map(String.init)
    var h = try G1Text.json(parts[2])
    h["seq"] = 99
    let forged = "g1.msg.\(Base64URL.encode(try JSONSerialization.data(withJSONObject: h))).\(parts[3])"
    let before = answer.recvSeq
    fails(ProtocolError.badTag, "header tamper") { _ = try answer.open(forged, crypto: crypto) }
    check(answer.recvSeq == before, "failed open does not move the counter")
    check(try answer.open(e3, crypto: crypto) == Data("x".utf8), "real one still opens")

    // Handshake refusals.
    fails(ProtocolError.badSignature, "hs2 from an impostor") {
        _ = try Handshake.finish(pending, peerSPKI: SoftwareIdentitySigner().publicKeySPKI, reply: reply, crypto: crypto, now: now)
    }
    fails(ProtocolError.stale, "old hs1") {
        _ = try Handshake.answer(signer: computer, peerSPKI: phone.publicKeySPKI, hello: pending.hello, crypto: crypto, now: now.addingTimeInterval(121))
    }
    fails(ProtocolError.badFormat, "hs1 for another computer") {
        _ = try Handshake.answer(signer: SoftwareIdentitySigner(), peerSPKI: phone.publicKeySPKI, hello: pending.hello, crypto: crypto, now: now)
    }
    check(Session.nonce(1) == Data([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), "nonce layout")
}

// MARK: - signed commands

func checkCommands() throws {
    let phone = SoftwareIdentitySigner()
    let computerId = id32()
    let signer = CommandSigner(signer: phone, counter: MonotonicCounter(store: InMemoryCounterStore()), crypto: crypto)
    let c1 = try signer.sign(body: #"{"type":"approval.decide","id":"a1","approve":true}"#, to: computerId, now: now)
    check(c1.ctr == 1 && c1.nonce.count == 22, "first counter, 16-byte nonce")
    try CommandSigner.check(c1, publicKeySPKI: phone.publicKeySPKI, selfId: computerId, lastCounter: 0, crypto: crypto, now: now)
    fails(ProtocolError.replay, "same counter again") {
        try CommandSigner.check(c1, publicKeySPKI: phone.publicKeySPKI, selfId: computerId, lastCounter: 1, crypto: crypto, now: now)
    }
    fails(ProtocolError.wrongTarget, "other computer") {
        try CommandSigner.check(c1, publicKeySPKI: phone.publicKeySPKI, selfId: id32(), lastCounter: 0, crypto: crypto, now: now)
    }
    fails(ProtocolError.stale, "outside the 2-minute window") {
        try CommandSigner.check(c1, publicKeySPKI: phone.publicKeySPKI, selfId: computerId, lastCounter: 0, crypto: crypto, now: now.addingTimeInterval(121))
    }
    let tampered = SignedCommand(device: c1.device, to: c1.to, ctr: c1.ctr, ts: c1.ts, nonce: c1.nonce, body: c1.body + " ", sig: c1.sig)
    fails(ProtocolError.badSignature, "body changed") {
        try CommandSigner.check(tampered, publicKeySPKI: phone.publicKeySPKI, selfId: computerId, lastCounter: 0, crypto: crypto, now: now)
    }
    let c2 = try signer.sign(body: "{}", to: computerId, now: now)
    check(c2.ctr == 2, "counter grows")
    let back = try JSONDecoder().decode(SignedCommand.self, from: try JSONEncoder().encode(c2))
    check(back == c2, "JSON round trip")

    let near = MonotonicCounter(store: InMemoryCounterStore(start: maxSafeInteger - 1))
    check(try near.next() == maxSafeInteger, "last safe counter")
    fails(ProtocolError.counterExhausted, "never past the safe integer") { _ = try near.next() }
}

// MARK: - replay window

func checkReplayWindow() throws {
    var w = ReplayWindow()
    check(!w.accept(0), "zero refused")
    check(w.accept(1), "1")
    check(!w.accept(1), "1 again")
    check(w.accept(5), "5")
    check(w.accept(3), "3 late")
    check(!w.accept(3), "3 again")
    check(w.accept(100), "100")
    check(!w.accept(36), "64 behind refused")
    check(w.accept(37), "63 behind accepted")
    check(w.accept(1000), "big jump")
    check(!w.accept(100), "far behind after jump")
    var back = try JSONDecoder().decode(ReplayWindow.self, from: try JSONEncoder().encode(w))
    check(!back.accept(1000) && back.accept(1001), "persists")
}

// MARK: - QR payload

func makeQR(computer: SoftwareIdentitySigner = SoftwareIdentitySigner(), exp: TimeInterval = 300,
            extra: String = "&relay=wss://relay.example.org/v1&lan=192.168.1.20:41521,office-mac.local:41521") -> String {
    "girru://pair?v=1&cid=\(computer.deviceId)&ck=\(Base64URL.encode(computer.publicKeySPKI))&pid=\(id32())&ps=\(id32())&exp=\(Int(now.timeIntervalSince1970 + exp))&name=Office%20Mac" + extra
}

func checkPayload() throws {
    let computer = SoftwareIdentitySigner()
    let p = try PairingPayloadParser.parse(makeQR(computer: computer), crypto: crypto, now: now)
    check(p.computerId == computer.deviceId && p.computerKey == computer.publicKeySPKI, "computer key and id")
    check(p.pairingSecret.count == 32 && Base64URL.isId(p.pairingId), "pairing secret and id")
    check(p.localAddresses == ["192.168.1.20:41521", "office-mac.local:41521"], "local addresses")
    check(p.relayURL?.scheme == "wss" && p.computerName == "Office Mac", "relay and name")

    let other = SoftwareIdentitySigner()
    let mismatched = makeQR(computer: computer).replacingOccurrences(of: "cid=\(computer.deviceId)", with: "cid=\(other.deviceId)")
    fails(PairingPayloadError.invalidField("ck"), "id does not match key") { _ = try PairingPayloadParser.parse(mismatched, crypto: crypto, now: now) }
    fails(PairingPayloadError.expired, "expired") { _ = try PairingPayloadParser.parse(makeQR(exp: -1), crypto: crypto, now: now) }
    fails(PairingPayloadError.invalidField("exp"), "over 10 minutes") { _ = try PairingPayloadParser.parse(makeQR(exp: 601), crypto: crypto, now: now) }
    fails(PairingPayloadError.invalidField("relay"), "plain ws relay") {
        _ = try PairingPayloadParser.parse(makeQR(extra: "&relay=ws://relay.example.org"), crypto: crypto, now: now)
    }
    fails(PairingPayloadError.invalidField("lan"), "public lan address") {
        _ = try PairingPayloadParser.parse(makeQR(extra: "&lan=8.8.8.8:80"), crypto: crypto, now: now)
    }
    fails(PairingPayloadError.noRoute, "no route") { _ = try PairingPayloadParser.parse(makeQR(extra: ""), crypto: crypto, now: now) }
    fails(PairingPayloadError.duplicateField("pid"), "duplicate field") {
        _ = try PairingPayloadParser.parse(makeQR(extra: "&lan=10.0.0.2:1&pid=\(id32())"), crypto: crypto, now: now)
    }
    fails(PairingPayloadError.notAGirruCode, "other scheme") { _ = try PairingPayloadParser.parse("https://example.org/pair", crypto: crypto, now: now) }

    check(LocalAddress.isPrivate(hostPort: "172.20.0.1:41521"), "172.16/12")
    check(!LocalAddress.isPrivate(hostPort: "172.32.0.1:41521"), "outside 172.16/12")
    check(LocalAddress.isPrivate(hostPort: "[fd12::1]:41521"), "IPv6 ULA")
    check(!LocalAddress.isPrivate(hostPort: "10.0.0.1:0"), "port 0")

    check(PairingCode.normalize("abcd-efgh-jkmn") == "ABCDEFGHJKMN", "typed code normalize")
    check(PairingCode.normalize("O1IL 2345 6789") == "011123456789", "look-alikes")
    check(PairingCode.normalize("ABCD-EFGH-JKMU") == nil, "U not in alphabet")
    check(PairingCode.display("ABCDEFGHJKMN") == "ABCD-EFGH-JKMN", "display groups")
}

// MARK: - pairing request / welcome / check code

func checkPairingMessages() throws {
    let computer = SoftwareIdentitySigner(), phone = SoftwareIdentitySigner()
    let payload = try PairingPayloadParser.parse(makeQR(computer: computer), crypto: crypto, now: now)
    let req = PairingRequest(key: Base64URL.encode(phone.publicKeySPKI), name: "Work iPhone", platform: "ios", push: nil, lifetimeDays: 60)
    let sealed = try PairingMessages.sealRequest(req, payload: payload, crypto: crypto)
    check(try PairingMessages.openRequest(sealed, payload: payload, crypto: crypto) == req, "request round trip")

    var wrongSecret = payload
    wrongSecret.pairingSecret = crypto.randomBytes(32)
    fails(ProtocolError.badTag, "request needs the QR secret") { _ = try PairingMessages.openRequest(sealed, payload: wrongSecret, crypto: crypto) }

    let welcome = PairingWelcome(computer: computer.deviceId, phone: phone.deviceId, notifyKey: Base64URL.encode(crypto.randomBytes(32)), lifetimeDays: 60, name: "Office Mac")
    let w = try PairingMessages.sealWelcome(welcome, payload: payload, computer: computer, crypto: crypto)
    check(try PairingMessages.openWelcome(w, payload: payload, phoneId: phone.deviceId, crypto: crypto) == welcome, "welcome round trip")
    fails(ProtocolError.badSignature, "welcome signed by someone else") {
        let fake = try PairingMessages.sealWelcome(welcome, payload: payload, computer: SoftwareIdentitySigner(), crypto: crypto)
        _ = try PairingMessages.openWelcome(fake, payload: payload, phoneId: phone.deviceId, crypto: crypto)
    }
    fails(ProtocolError.wrongTarget, "welcome for another phone") {
        _ = try PairingMessages.openWelcome(w, payload: payload, phoneId: id32(), crypto: crypto)
    }
    var badLifetime = welcome
    badLifetime.lifetimeDays = 45
    fails(ProtocolError.badFormat, "lifetime not on the list") {
        let x = try PairingMessages.sealWelcome(badLifetime, payload: payload, computer: computer, crypto: crypto)
        _ = try PairingMessages.openWelcome(x, payload: payload, phoneId: phone.deviceId, crypto: crypto)
    }

    let code = PairingMessages.checkCode(secret: payload.pairingSecret, computerKey: computer.publicKeySPKI, phoneKey: phone.publicKeySPKI, crypto: crypto)
    check(code.count == 6 && code.allSatisfy(\.isNumber), "6-digit check code")
    check(code == PairingMessages.checkCode(secret: payload.pairingSecret, computerKey: computer.publicKeySPKI, phoneKey: phone.publicKeySPKI, crypto: crypto), "check code is stable")
}

// MARK: - pairing lifetime

func computerRecord(_ lifetime: PairingLifetime, computer: SoftwareIdentitySigner = SoftwareIdentitySigner(), phoneId: String = id32(), notifyKey: Data = crypto.randomBytes(32)) -> PairedComputer {
    PairedComputer(computerId: computer.deviceId, computerName: nil, computerKey: computer.publicKeySPKI, relayURL: nil,
                   localAddresses: ["10.0.0.2:41521"], webURL: nil, phoneId: phoneId, notifyKey: notifyKey, pairedAt: now, lifetime: lifetime)
}

func checkLifetime() throws {
    let day: TimeInterval = 86_400
    var c = computerRecord(.days30)
    check(!c.isExpired(now: now.addingTimeInterval(30 * day)), "exactly 30 days is still valid (same rule as the computer)")
    check(c.isExpired(now: now.addingTimeInterval(30 * day + 1)), "after 30 days expired")
    check(c.renew(at: now.addingTimeInterval(29 * day)), "use renews")
    check(!c.isExpired(now: now.addingTimeInterval(58 * day)), "sliding: 29 + 29 days still valid")
    check(c.isExpired(now: now.addingTimeInterval(60 * day)), "sliding: then expires")
    check(!c.renew(at: now.addingTimeInterval(60 * day)), "expired is not revived")

    var d = computerRecord(.days60)
    d.renew(at: now.addingTimeInterval(1000))
    d.renew(at: now)
    check(d.lastUsedAt == now.addingTimeInterval(1000), "renew never moves back")

    let n = computerRecord(.never)
    check(n.expiresAt == nil && !n.isExpired(now: now.addingTimeInterval(3650 * day)), "never expires")
    check(PairingLifetime.never.warning != nil && PairingLifetime.days90.warning == nil, "warning only for never")
    check(PairingLifetime(days: nil) == .never && PairingLifetime(days: 120) == .days120 && PairingLifetime(days: 7) == nil, "wire values")

    check(PairingState.evaluate(nil, now: now) == .notPaired, "not paired")
    let e = computerRecord(.days120)
    check(PairingState.evaluate(e, now: now) == .paired(e), "paired")
    check(PairingState.evaluate(e, now: now.addingTimeInterval(121 * day)) == .ended(.expired), "ended")
    check(try JSONDecoder().decode(PairedComputer.self, from: try JSONEncoder().encode(e)) == e, "record round trip")
}

// MARK: - lock policy

func checkLock() throws {
    var p = LockPolicy()
    check(p.relockDelay == LockPolicy.maximumDelay, "default is the maximum")
    check(!p.setRelockDelay(3600) && !p.setRelockDelay(.infinity), "cannot loosen")
    check(p.setRelockDelay(15) && p.relockDelay == 15, "can shorten")
    check(LockPolicy(relockDelay: 99_999).relockDelay == LockPolicy.maximumDelay, "init clamps")
    check(try JSONDecoder().decode(LockPolicy.self, from: Data("1e9".utf8)).relockDelay == LockPolicy.maximumDelay, "stored value clamps")
    let q = LockPolicy(relockDelay: 30)
    check(q.shouldLock(backgroundedAt: nil, now: now), "fresh launch locks")
    check(!q.shouldLock(backgroundedAt: now, now: now.addingTimeInterval(29)), "short trip stays open")
    check(q.shouldLock(backgroundedAt: now, now: now.addingTimeInterval(30)), "after delay locks")
    check(q.shouldLock(backgroundedAt: now, now: now.addingTimeInterval(-5)), "clock moved back locks")
}

// MARK: - bridge and navigation

func checkBridge() throws {
    check(try BridgeMessageParser.parse(["type": "lock.state"]) == .lockState, "lock.state")
    check(try BridgeMessageParser.parse(["type": "qr.scan"]) == .scanQR, "qr.scan")
    check(try BridgeMessageParser.parse(["type": "auth.request", "reason": " Open the terminal "]) == .authenticate(reason: "Open the terminal"), "auth.request")
    check(try BridgeMessageParser.parse(["type": "push.permission"]) == .pushPermission(request: false), "push.permission")
    check(try BridgeMessageParser.parse(["type": "push.permission", "request": NSNumber(value: true)]) == .pushPermission(request: true), "push.permission request")
    fails(BridgeError.notAnObject, "string body") { _ = try BridgeMessageParser.parse("lock.state") }
    fails(BridgeError.unknownType, "unknown type") { _ = try BridgeMessageParser.parse(["type": "eval"]) }
    fails(BridgeError.unexpectedField("x"), "extra field") { _ = try BridgeMessageParser.parse(["type": "lock.state", "x": 1]) }
    fails(BridgeError.invalidField("reason"), "empty reason") { _ = try BridgeMessageParser.parse(["type": "auth.request", "reason": ""]) }
    fails(BridgeError.invalidField("reason"), "long reason") {
        _ = try BridgeMessageParser.parse(["type": "auth.request", "reason": String(repeating: "a", count: 121)])
    }
    fails(BridgeError.invalidField("request"), "number is not a boolean") {
        _ = try BridgeMessageParser.parse(["type": "push.permission", "request": NSNumber(value: 1)])
    }

    let policy = NavigationPolicy(pairedOrigin: WebOrigin(url: URL(string: "http://192.168.1.20:41522/")!), fallbackPage: URL(fileURLWithPath: "/app/NotPaired.html"))
    func d(_ s: String, main: Bool = true, user: Bool = false) -> NavigationDecision { policy.decide(URL(string: s)!, isMainFrame: main, userInitiated: user) }
    check(d("http://192.168.1.20:41522/chat") == .allow, "paired origin")
    check(d("HTTP://192.168.1.20:41522/x", main: false) == .allow, "case-insensitive origin")
    check(d("http://192.168.1.20:9999/") == .deny, "other port")
    check(d("https://example.org/", user: true) == .openExternally, "tapped link goes to Safari")
    check(d("https://example.org/") == .deny, "scripted redirect dropped")
    check(d("https://example.org/", main: false, user: true) == .deny, "foreign frame")
    check(policy.decide(URL(fileURLWithPath: "/app/NotPaired.html"), isMainFrame: true, userInitiated: false) == .allow, "fallback page")
    check(policy.decide(URL(fileURLWithPath: "/etc/hosts"), isMainFrame: true, userInitiated: false) == .deny, "other files")
    check(d("javascript:alert(1)", user: true) == .deny, "javascript: refused")
    check(d("mailto:a@example.org", user: true) == .openExternally, "mailto")
    check(d("about:blank", main: false) == .allow, "about:blank")
}

// MARK: - notices

func checkNotices() throws {
    let computer = SoftwareIdentitySigner()
    let phoneId = id32()
    let key = crypto.randomBytes(32)
    let record = computerRecord(.days90, computer: computer, phoneId: phoneId, notifyKey: key)
    let content = NoticeContent(kind: .approval, title: "Sara wants to send an email", body: "Weekly sales report to the sales team (6 people)", approvalId: "approval-1234")

    let g = try Notice.seal(content, computer: computer, phoneId: phoneId, counter: 7, notifyKey: key, crypto: crypto, now: now)
    var window = ReplayWindow()
    let late = now.addingTimeInterval(20 * 60)
    check(try Notice.open(userInfo: ["g": g], computer: record, replay: &window, crypto: crypto, now: late) == content, "late notice opens")
    fails(ProtocolError.replay, "notice replay") { _ = try Notice.open(userInfo: ["g": g], computer: record, replay: &window, crypto: crypto, now: late) }

    var fresh = ReplayWindow()
    let forged = try Notice.seal(content, computer: SoftwareIdentitySigner(), phoneId: phoneId, counter: 8, notifyKey: key, crypto: crypto, now: now)
    fails(ProtocolError.badSignature, "unsigned / forged notice") { _ = try Notice.open(userInfo: ["g": forged], computer: record, replay: &fresh, crypto: crypto, now: now) }
    check(fresh == ReplayWindow(), "forged notice leaves no state")
    var other = record
    other.notifyKey = crypto.randomBytes(32)
    fails(ProtocolError.badTag, "wrong notification key") { _ = try Notice.open(userInfo: ["g": g], computer: other, replay: &fresh, crypto: crypto, now: now) }
    fails(ProtocolError.stale, "older than an hour") { _ = try Notice.open(userInfo: ["g": g], computer: record, replay: &fresh, crypto: crypto, now: now.addingTimeInterval(3601)) }
    fails(ProtocolError.badFormat, "no payload") { _ = try Notice.open(userInfo: [:], computer: record, replay: &fresh, crypto: crypto, now: now) }
    check(!Notice.isValid(NoticeContent(kind: .approval, title: "t", body: "b")), "approval needs an id")
}

// MARK: - interop line protocol

/// Speaks with the computer's reference code over stdin/stdout, one JSON object per line.
func interop() throws {
    func send(_ obj: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        fflush(stdout)
    }
    func receive() throws -> [String: Any] {
        guard let line = readLine(), let obj = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
            throw ProtocolError.badFormat
        }
        return obj
    }

    let phone = SoftwareIdentitySigner()
    send(["key": Base64URL.encode(phone.publicKeySPKI), "id": phone.deviceId])
    let first = try receive()
    guard let ckText = first["key"] as? String, let ck = Base64URL.decode(ckText), let cid = first["id"] as? String,
          crypto.isValidPublicKey(ck, expectedId: cid) else { throw ProtocolError.wrongKey }

    let pending = try Handshake.start(signer: phone, peerId: cid, crypto: crypto)
    send(["hs1": pending.hello])
    guard let hs2 = try receive()["hs2"] as? String else { throw ProtocolError.badFormat }
    var session = try Handshake.finish(pending, peerSPKI: ck, reply: hs2, crypto: crypto)
    send(["msg": try session.seal(Data("hello from the phone".utf8), crypto: crypto), "sid": session.id])
    guard let reply = try receive()["msg"] as? String else { throw ProtocolError.badFormat }
    let text = String(decoding: try session.open(reply, crypto: crypto), as: UTF8.self)
    let signer = CommandSigner(signer: phone, counter: MonotonicCounter(store: InMemoryCounterStore()), crypto: crypto)
    let cmd = try signer.sign(body: #"{"type":"chat.send","text":"hi"}"#, to: cid)
    let cmdJSON = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(cmd))
    send(["reply": text, "cmd": cmdJSON])
}

if CommandLine.arguments.dropFirst().first == "interop" {
    do { try interop() } catch {
        FileHandle.standardError.write(Data("interop failed: \(error)\n".utf8))
        exit(1)
    }
    exit(0)
}

let groups: [(String, () throws -> Void)] = [
    ("base64url", checkBase64), ("crypto", checkCrypto), ("session", checkSession), ("commands", checkCommands),
    ("replay window", checkReplayWindow), ("QR payload", checkPayload), ("pairing messages", checkPairingMessages),
    ("pairing lifetime", checkLifetime), ("lock policy", checkLock), ("bridge + navigation", checkBridge), ("notices", checkNotices),
]
for (name, run) in groups {
    do { try run() } catch {
        print("FAIL \(name): threw \(error)")
        failures += 1
    }
}
print("\(passes) passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)
