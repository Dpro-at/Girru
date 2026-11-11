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

    // A fresh hs1 for every handshake: the computer answers each text once.
    let again = try Handshake.start(signer: phone, peerId: computer.deviceId, crypto: crypto, now: now)
    check(again.hello != pending.hello, "a new handshake is a new hs1")
    let p1 = try G1Text.json(String(pending.hello.split(separator: ".")[2])), p2 = try G1Text.json(String(again.hello.split(separator: ".")[2]))
    check(p1["eph"] as? String != p2["eph"] as? String && p1["nonce"] as? String != p2["nonce"] as? String, "fresh ephemeral key and nonce")
    fails(ProtocolError.badFormat, "an hs2 answers only its own hs1") {
        _ = try Handshake.finish(again, peerSPKI: computer.publicKeySPKI, reply: reply, crypto: crypto, now: now)
    }
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
    "girru://pair?v=1&cid=\(computer.deviceId)&ck=\(Base64URL.encode(computer.publicKeySPKI))&pid=p_\(id32())&ps=\(id32())&exp=\(Int(now.timeIntervalSince1970 + exp))&name=Office%20Mac" + extra
}

func checkPayload() throws {
    let computer = SoftwareIdentitySigner()
    let p = try PairingPayloadParser.parse(makeQR(computer: computer), crypto: crypto, now: now)
    check(p.computerId == computer.deviceId && p.computerKey == computer.publicKeySPKI, "computer key and id")
    check(p.pairingSecret.count == 32 && p.pairingId.hasPrefix("p_") && p.pairingId.count == 45, "pairing secret and p_ id")
    check(p.localAddresses == ["192.168.1.20:41521", "office-mac.local:41521"], "local addresses")
    check(p.relay == "wss://relay.example.org/v1" && p.computerName == "Office Mac", "relay kept unchanged, name")

    let bare = makeQR(computer: computer).replacingOccurrences(of: "pid=p_", with: "pid=")
    fails(PairingPayloadError.invalidField("pid"), "pid without p_") { _ = try PairingPayloadParser.parse(bare, crypto: crypto, now: now) }
    for bad in ["https://relay.example.org/v1", "wss://relay.example.org", "wss://relay.example.org/v2", "wss://relay.example.org/v1/",
                "wss://user@relay.example.org/v1", "wss://relay.example.org/x/v1", "wss://relay.example.org/v1?x=1", "wss:///v1"] {
        check(!RelayName.isValid(bad), "relay name refused: \(bad)")
    }
    check(RelayName.isValid("wss://relay.example.org:8443/v1") && RelayName.isValid("wss://[fd00::1]:8443/v1"), "relay with port / IPv6")
    check(RelayName.challengeMatches("wss://relay.example.org/v1", configured: p.relay!), "challenge relay matches exactly")
    check(!RelayName.challengeMatches("wss://Relay.example.org/v1", configured: p.relay!), "challenge compare is exact")
    check(!RelayName.challengeMatches("wss://evil.example.org/v1", configured: p.relay!), "other relay refused")

    let other = SoftwareIdentitySigner()
    let mismatched = makeQR(computer: computer).replacingOccurrences(of: "cid=\(computer.deviceId)", with: "cid=\(other.deviceId)")
    fails(PairingPayloadError.invalidField("ck"), "id does not match key") { _ = try PairingPayloadParser.parse(mismatched, crypto: crypto, now: now) }
    fails(PairingPayloadError.expired, "expired") { _ = try PairingPayloadParser.parse(makeQR(exp: -1), crypto: crypto, now: now) }
    fails(PairingPayloadError.invalidField("exp"), "over 10 minutes") { _ = try PairingPayloadParser.parse(makeQR(exp: 601), crypto: crypto, now: now) }
    fails(PairingPayloadError.invalidField("relay"), "plain ws relay") {
        _ = try PairingPayloadParser.parse(makeQR(extra: "&relay=ws://relay.example.org/v1"), crypto: crypto, now: now)
    }
    fails(PairingPayloadError.invalidField("lan"), "public lan address") {
        _ = try PairingPayloadParser.parse(makeQR(extra: "&lan=8.8.8.8:80"), crypto: crypto, now: now)
    }
    fails(PairingPayloadError.noRoute, "no route") { _ = try PairingPayloadParser.parse(makeQR(extra: ""), crypto: crypto, now: now) }
    fails(PairingPayloadError.duplicateField("pid"), "duplicate field") {
        _ = try PairingPayloadParser.parse(makeQR(extra: "&lan=10.0.0.2:1&pid=p_\(id32())"), crypto: crypto, now: now)
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
    let sealed = try PairingMessages.sealRequest(req, signer: phone, payload: payload, crypto: crypto)
    let opened = try PairingMessages.openRequest(sealed, payload: payload, crypto: crypto)
    check(opened.key == req.key && opened.name == "Work iPhone" && opened.lifetimeDays == 60 && opened.sig != nil, "request round trip with sig")

    // The salt is the full pid text, p_ included.
    var noPrefix = payload
    noPrefix.pairingId = String(payload.pairingId.dropFirst(2))
    check(PairingMessages.pairingKey(noPrefix, crypto: crypto) != PairingMessages.pairingKey(payload, crypto: crypto), "salt includes p_")
    check(PairingMessages.pairingKey(payload, crypto: crypto) == crypto.hkdf(payload.pairingSecret, salt: Data(payload.pairingId.utf8), info: Data("girru/v1/pair".utf8), count: 32), "pairing key formula")

    // The signature covers pid, the phone's id and the nonce, with the key it carries.
    let nonceText = String(sealed.split(separator: ".")[2])
    check(crypto.verify(signature: Base64URL.decode(opened.sig!)!, message: Data("girru/v1/preq-sig\n\(payload.pairingId)\n\(phone.deviceId)\n\(nonceText)".utf8), publicKeySPKI: phone.publicKeySPKI), "preq sig byte layout")
    fails(ProtocolError.badSignature, "request carrying a key it cannot sign for") {
        // Someone who saw the QR code sends the real phone's key, signed by another key.
        let impostor = SoftwareIdentitySigner()
        let key = PairingMessages.pairingKey(payload, crypto: crypto)
        let nonce = crypto.randomBytes(12)
        var forged = req
        forged.sig = Base64URL.encode(try impostor.sign(PairingRequest.signedText(pairingId: payload.pairingId, phoneId: phone.deviceId, nonce: Base64URL.encode(nonce))))
        let box = try crypto.seal(try JSONEncoder().encode(forged), key: key, nonce: nonce, aad: Data("girru/v1/preq\n\(payload.pairingId)".utf8))
        _ = try PairingMessages.openRequest("g1.preq.\(Base64URL.encode(nonce)).\(Base64URL.encode(box))", payload: payload, crypto: crypto)
    }
    fails(ProtocolError.badSignature, "request without sig") {
        let key = PairingMessages.pairingKey(payload, crypto: crypto)
        let nonce = crypto.randomBytes(12)
        let box = try crypto.seal(try JSONEncoder().encode(req), key: key, nonce: nonce, aad: Data("girru/v1/preq\n\(payload.pairingId)".utf8))
        _ = try PairingMessages.openRequest("g1.preq.\(Base64URL.encode(nonce)).\(Base64URL.encode(box))", payload: payload, crypto: crypto)
    }

    var wrongSecret = payload
    wrongSecret.pairingSecret = crypto.randomBytes(32)
    fails(ProtocolError.badTag, "request needs the QR secret") { _ = try PairingMessages.openRequest(sealed, payload: wrongSecret, crypto: crypto) }

    // Check challenge: signed by the computer, sealed, addressed to this phone.
    let (pchal, challenge) = try PairingMessages.sealChallenge(payload: payload, computer: computer, phoneId: phone.deviceId, crypto: crypto)
    check(try PairingMessages.openChallenge(pchal, payload: payload, phoneId: phone.deviceId, crypto: crypto) == challenge, "challenge round trip")
    check(challenge.count == 32, "challenge is 32 bytes")
    fails(ProtocolError.badSignature, "challenge signed by someone else") {
        let fake = try PairingMessages.sealChallenge(payload: payload, computer: SoftwareIdentitySigner(), phoneId: phone.deviceId, crypto: crypto).text
        _ = try PairingMessages.openChallenge(fake, payload: payload, phoneId: phone.deviceId, crypto: crypto)
    }
    fails(ProtocolError.wrongTarget, "challenge for another phone") {
        _ = try PairingMessages.openChallenge(pchal, payload: payload, phoneId: id32(), crypto: crypto)
    }
    fails(ProtocolError.badTag, "challenge needs the QR secret") {
        _ = try PairingMessages.openChallenge(pchal, payload: wrongSecret, phoneId: phone.deviceId, crypto: crypto)
    }
    fails(ProtocolError.badFormat, "short challenge is not sealed") {
        _ = try PairingMessages.sealChallenge(payload: payload, computer: computer, phoneId: phone.deviceId, crypto: crypto, challenge: Data(count: 31))
    }
    fails(ProtocolError.badFormat, "short challenge inside a signed box") {
        // A computer-signed box whose challenge has 31 bytes.
        let body = try JSONSerialization.data(withJSONObject: ["computer": computer.deviceId, "phone": phone.deviceId, "challenge": Base64URL.encode(Data(count: 31))])
        let nonce = crypto.randomBytes(12)
        let box = try crypto.seal(body, key: PairingMessages.pairingKey(payload, crypto: crypto), nonce: nonce, aad: Data("girru/v1/pchal\n\(payload.pairingId)".utf8))
        let part = Base64URL.encode(nonce + box)
        _ = try PairingMessages.openChallenge("g1.pchal.\(part).\(Base64URL.encode(try computer.sign(Data("girru/v1/pchal\n\(part)".utf8))))", payload: payload, phoneId: phone.deviceId, crypto: crypto)
    }

    let code = try PairingMessages.checkCode(secret: payload.pairingSecret, computerKey: computer.publicKeySPKI, phoneKey: phone.publicKeySPKI, challenge: challenge, crypto: crypto)
    check(code.count == 6 && code.allSatisfy(\.isNumber), "6-digit check code")
    check(code == (try PairingMessages.checkCode(secret: payload.pairingSecret, computerKey: computer.publicKeySPKI, phoneKey: phone.publicKeySPKI, challenge: challenge, crypto: crypto)), "check code is stable")
    fails(ProtocolError.badFormat, "no check code without a 32-byte challenge") {
        _ = try PairingMessages.checkCode(secret: payload.pairingSecret, computerKey: computer.publicKeySPKI, phoneKey: phone.publicKeySPKI, challenge: Data(), crypto: crypto)
    }

    // Welcome: the notification key is wrapped for the two identity keys.
    let rawKey = crypto.randomBytes(32)
    let welcome = PairingWelcome(computer: computer.deviceId, phone: phone.deviceId, notifyKey: Base64URL.encode(rawKey), lifetimeDays: 60, name: "Office Mac")
    let w = try PairingMessages.sealWelcome(welcome, payload: payload, computer: computer, phoneKey: phone.publicKeySPKI, crypto: crypto)
    check(try PairingMessages.openWelcome(w, payload: payload, phone: phone, crypto: crypto) == welcome, "welcome round trip, key unwrapped")
    fails(ProtocolError.badSignature, "welcome signed by someone else") {
        let fake = try PairingMessages.sealWelcome(welcome, payload: payload, computer: SoftwareIdentitySigner(), phoneKey: phone.publicKeySPKI, crypto: crypto)
        _ = try PairingMessages.openWelcome(fake, payload: payload, phone: phone, crypto: crypto)
    }
    fails(ProtocolError.wrongTarget, "welcome for another phone") {
        _ = try PairingMessages.openWelcome(w, payload: payload, phone: SoftwareIdentitySigner(), crypto: crypto)
    }
    fails(ProtocolError.wrongKey, "welcome sealed for a key that is not the phone's") {
        _ = try PairingMessages.sealWelcome(welcome, payload: payload, computer: computer, phoneKey: SoftwareIdentitySigner().publicKeySPKI, crypto: crypto)
    }
    var badLifetime = welcome
    badLifetime.lifetimeDays = 45
    fails(ProtocolError.badFormat, "lifetime not on the list") {
        let x = try PairingMessages.sealWelcome(badLifetime, payload: payload, computer: computer, phoneKey: phone.publicKeySPKI, crypto: crypto)
        _ = try PairingMessages.openWelcome(x, payload: payload, phone: phone, crypto: crypto)
    }
    fails(ProtocolError.badFormat, "an unwrapped 32-byte key is refused") {
        // The old form: notifyKey as the raw key, signed and sealed correctly.
        let nonce = crypto.randomBytes(12)
        let box = try crypto.seal(try JSONEncoder().encode(welcome), key: PairingMessages.pairingKey(payload, crypto: crypto), nonce: nonce, aad: Data("girru/v1/pwel\n\(payload.pairingId)".utf8))
        let part = Base64URL.encode(nonce + box)
        _ = try PairingMessages.openWelcome("g1.pwel.\(part).\(Base64URL.encode(try computer.sign(Data("girru/v1/pwel\n\(part)".utf8))))", payload: payload, phone: phone, crypto: crypto)
    }
    // The wrap key is ECDH(phone, computer) → HKDF(salt = pairing key, info "girru/v1/nkey").
    let wrapPhone = try phone.agree(peerSPKI: computer.publicKeySPKI, salt: PairingMessages.pairingKey(payload, crypto: crypto), info: Data("girru/v1/nkey".utf8), count: 32)
    let wrapComputer = try computer.agree(peerSPKI: phone.publicKeySPKI, salt: PairingMessages.pairingKey(payload, crypto: crypto), info: Data("girru/v1/nkey".utf8), count: 32)
    check(wrapPhone == wrapComputer, "both sides make the same wrap key")
    fails(ProtocolError.wrongKey, "agreement with junk key") { _ = try phone.agree(peerSPKI: Data(count: 91), salt: Data(), info: Data(), count: 32) }
}

// MARK: - reference vectors (computer's TypeScript)

func signer(d: String) throws -> SoftwareIdentitySigner { try SoftwareIdentitySigner(rawPrivateKey: Base64URL.decode(d)!) }

func checkReferenceVectors() throws {
    typealias V = ReferenceVectors
    let computer = try signer(d: V.computerD), phone = try signer(d: V.phoneD), other = try signer(d: V.otherD)
    let payload = try PairingPayloadParser.parse(V.qr, crypto: crypto, now: now)
    check(payload.computerId == computer.deviceId && payload.pairingId == V.pid && payload.pairingSecret == Base64URL.decode(V.secret), "reference QR reads")
    check(payload.expiresAt == now.addingTimeInterval(120), "QR renews every 2 minutes: exp 2 minutes ahead")

    let req = try PairingMessages.openRequest(V.preq, payload: payload, crypto: crypto)
    check(req.key == Base64URL.encode(phone.publicKeySPKI) && req.lifetimeDays == 60 && req.name == "Work iPhone", "reference request opens and its sig verifies")

    let challenge = try PairingMessages.openChallenge(V.pchal, payload: payload, phoneId: phone.deviceId, crypto: crypto)
    check(Base64URL.encode(challenge) == V.challenge, "reference challenge opens")
    check(try PairingMessages.checkCode(secret: payload.pairingSecret, computerKey: computer.publicKeySPKI, phoneKey: phone.publicKeySPKI, challenge: challenge, crypto: crypto) == V.code, "check code matches the reference")
    check(try PairingMessages.checkCode(secret: Data(repeating: 1, count: 32), computerKey: computer.publicKeySPKI, phoneKey: phone.publicKeySPKI, challenge: Data(repeating: 0xaa, count: 32), crypto: crypto) == V.fixedCode, "fixed-input check code matches the reference")
    fails(ProtocolError.wrongTarget, "reference challenge for another phone is refused") {
        _ = try PairingMessages.openChallenge(V.pchalOther, payload: payload, phoneId: phone.deviceId, crypto: crypto)
    }
    check(try PairingMessages.openChallenge(V.pchalOther, payload: payload, phoneId: other.deviceId, crypto: crypto).count == 32, "…and opens for that phone")

    let w = try PairingMessages.openWelcome(V.pwel, payload: payload, phone: phone, crypto: crypto)
    check(w.notifyKey == V.notifyKey && w.lifetimeDays == 60 && w.name == "Office Mac" && w.phone == phone.deviceId, "reference welcome opens, notification key unwrapped")
    let never = try PairingMessages.openWelcome(V.pwelNever, payload: payload, phone: phone, crypto: crypto)
    check(never.lifetimeDays == nil && PairingLifetime(days: never.lifetimeDays) == .never && never.notifyKey == V.notifyKey, "reference welcome with no lifetime = never expires")
    fails(ProtocolError.wrongTarget, "another phone cannot open the welcome") {
        _ = try PairingMessages.openWelcome(V.pwel, payload: payload, phone: other, crypto: crypto)
    }

    // The unwrapped key opens the computer's notice.
    let record = PairedComputer(computerId: computer.deviceId, computerName: nil, computerKey: computer.publicKeySPKI, relay: nil, localAddresses: [],
                                phoneId: phone.deviceId, notifyKey: Base64URL.decode(w.notifyKey)!, pairedAt: now, lifetime: .days60)
    var window = ReplayWindow()
    let n = try Notice.open(userInfo: ["g": V.ntf], computer: record, replay: &window, crypto: crypto, now: now)
    check(n.kind == .approval && n.approvalId == "abc-1" && n.title == "Approve?", "reference notice opens with the unwrapped key")

    // The phone's progress against the reference envelopes.
    var progress = PairingProgress(payload: payload, phoneKey: phone.publicKeySPKI)
    fails(ProtocolError.badFormat, "no challenge before the request") { _ = try progress.receiveChallenge(V.pchal, crypto: crypto, now: now) }
    let sent = try progress.requestText(PairingRequest(key: "", name: "Work iPhone", platform: "ios", push: nil, lifetimeDays: nil), signer: phone, crypto: crypto, now: now)
    fails(ProtocolError.badFormat, "no welcome before a code was shown") { _ = try progress.receiveWelcome(V.pwel, phone: phone, crypto: crypto) }
    check(try progress.receiveChallenge(V.pchal, crypto: crypto, now: now.addingTimeInterval(30)) == V.code, "progress shows the reference code")
    check(progress.stage == .codeShown(V.code), "stage: code shown")
    check(try progress.receiveWelcome(V.pwel, phone: phone, crypto: crypto).notifyKey == V.notifyKey && progress.stage == .paired, "progress takes the welcome")
    check(sent.hasPrefix("g1.preq."), "request sealed")
}

// MARK: - pairing progress (phone side rules)

func checkPairingProgress() throws {
    let computer = SoftwareIdentitySigner(), phone = SoftwareIdentitySigner()
    let payload = try PairingPayloadParser.parse(makeQR(computer: computer, exp: 120), crypto: crypto, now: now)
    let req = PairingRequest(key: "", name: "Work iPhone", platform: "ios", push: nil, lifetimeDays: 90)

    var p = PairingProgress(payload: payload, phoneKey: phone.publicKeySPKI)
    check(p.stage == .scanned, "starts scanned")
    let first = try p.requestText(req, signer: phone, crypto: crypto, now: now)
    check(try p.requestText(req, signer: phone, crypto: crypto, now: now.addingTimeInterval(200)) == first, "a resend is the same request, byte for byte")
    check(try PairingMessages.openRequest(first, payload: payload, crypto: crypto).lifetimeDays == 90, "request carries the wish")

    // Idempotent: the same challenge again shows the same code; a different one ends it.
    let (c1, _) = try PairingMessages.sealChallenge(payload: payload, computer: computer, phoneId: phone.deviceId, crypto: crypto)
    let code = try p.receiveChallenge(c1, crypto: crypto, now: now.addingTimeInterval(60))
    check(try p.receiveChallenge(c1, crypto: crypto, now: now.addingTimeInterval(61)) == code, "same challenge again: same code")
    let (c2, _) = try PairingMessages.sealChallenge(payload: payload, computer: computer, phoneId: phone.deviceId, crypto: crypto)
    fails(ProtocolError.wrongTarget, "a different second challenge is refused") { _ = try p.receiveChallenge(c2, crypto: crypto, now: now.addingTimeInterval(62)) }
    check(p.isCurrent(now: now.addingTimeInterval(600)), "after the challenge, the renewed QR does not end this pairing")
    let raw = crypto.randomBytes(32)
    let w = try PairingMessages.sealWelcome(PairingWelcome(computer: computer.deviceId, phone: phone.deviceId, notifyKey: Base64URL.encode(raw), lifetimeDays: nil, name: nil),
                                            payload: payload, computer: computer, phoneKey: phone.publicKeySPKI, crypto: crypto)
    check(try p.receiveWelcome(w, phone: phone, crypto: crypto).notifyKey == Base64URL.encode(raw), "welcome after the code")

    // exp passed before the challenge: the owner scans the new code.
    var late = PairingProgress(payload: payload, phoneKey: phone.publicKeySPKI)
    check(!late.isCurrent(now: now.addingTimeInterval(120)), "at exp the code no longer counts")
    fails(ProtocolError.expired, "no request after exp") { _ = try late.requestText(req, signer: phone, crypto: crypto, now: now.addingTimeInterval(121)) }
    _ = try late.requestText(req, signer: phone, crypto: crypto, now: now.addingTimeInterval(100))
    let (c3, _) = try PairingMessages.sealChallenge(payload: payload, computer: computer, phoneId: phone.deviceId, crypto: crypto)
    fails(ProtocolError.expired, "challenge after exp is not shown") { _ = try late.receiveChallenge(c3, crypto: crypto, now: now.addingTimeInterval(125)) }
    check(late.challenge == nil && late.stage == .requestSent, "no code after exp")
    check(!PairingProgress.expiredMessage.isEmpty && PairingProgress.expiredMessage.contains("scan"), "plain expiry text")

    var wrongSigner = PairingProgress(payload: payload, phoneKey: phone.publicKeySPKI)
    fails(ProtocolError.wrongKey, "request only with the phone's own key") { _ = try wrongSigner.requestText(req, signer: SoftwareIdentitySigner(), crypto: crypto, now: now) }

    // A challenge for another phone shows no code.
    var mine = PairingProgress(payload: payload, phoneKey: phone.publicKeySPKI)
    _ = try mine.requestText(req, signer: phone, crypto: crypto, now: now)
    let (forOther, _) = try PairingMessages.sealChallenge(payload: payload, computer: computer, phoneId: id32(), crypto: crypto)
    fails(ProtocolError.wrongTarget, "challenge for another phone") { _ = try mine.receiveChallenge(forOther, crypto: crypto, now: now) }
    check(mine.stage == .requestSent, "no code shown")
}

// MARK: - session messages and approvals

func json(_ s: String) -> Data { Data(s.utf8) }

func checkSessionMessages() throws {
    // reply / run / run.end, as the computer's service sends them.
    if case .reply(let ref, true, let data, nil) = try ComputerMessage.parse(json(#"{"type":"reply","ref":"r1","ok":true,"data":{"x":1}}"#)) {
        check(ref == "r1" && (data as? [String: Any])?["x"] as? Int == 1, "reply ok")
    } else { check(false, "reply ok parses") }
    if case .reply(nil, false, nil, let e) = try ComputerMessage.parse(json(#"{"type":"reply","ref":null,"ok":false,"error":"bad_format"}"#)) {
        check(e == "bad_format", "reply without ref")
    } else { check(false, "reply without ref parses") }
    fails(ProtocolError.badFormat, "ok must be a JSON boolean") { _ = try ComputerMessage.parse(json(#"{"type":"reply","ref":"r","ok":1,"data":{}}"#)) }
    if case .runEnd(_, "phone-1", let end, let code) = try ComputerMessage.parse(json(#"{"type":"run.end","ref":"r1","runId":"phone-1","status":"dropped","code":"slow_link"}"#)) {
        check(end == .reread && code == "slow_link", "slow_link: read the rest with chat.messages")
    } else { check(false, "run.end parses") }
    check(RunEnd(status: "complete", code: nil) == .complete, "complete")
    check(RunEnd(status: "stopped", code: nil) == .stopped, "stopped")
    check(RunEnd(status: "error", code: "internal_error") == .failed, "error = failure")
    check(RunEnd(status: "unknown", code: nil) == .reread, "unknown run: re-read")
    check(RunEnd(status: "something-new", code: nil) == .failed, "unknown status = failure")
    if case .run(_, "phone-1", 3, let frame) = try ComputerMessage.parse(json(#"{"type":"run","ref":"r1","runId":"phone-1","seq":3,"frame":{"type":"delta"}}"#)) {
        check(frame["type"] as? String == "delta", "run frame")
    } else { check(false, "run parses") }
    if case .approvalPending("a1", true) = try ComputerMessage.parse(json(#"{"type":"approval.pending","id":"a1","pending":true}"#)) { check(true, "pending answer") } else { check(false, "pending answer parses") }
    fails(ProtocolError.badFormat, "unknown type") { _ = try ComputerMessage.parse(json(#"{"type":"other"}"#)) }

    check(CommandFailure.message(for: "internal_error") == CommandFailure.message(for: "never_seen_code"), "internal_error is a generic failure")
    check(!CommandFailure.message(for: "internal_error").contains("internal_error"), "raw code never shown")
    for c in ["full_view_required", "full_view_unavailable", "too_large"] {
        check(CommandFailure.message(for: c).contains("on your computer") && CommandFailure.decideOnComputer.contains(c), "\(c): decide on the computer")
    }

    check(try CommandBody.chatMessages(conversationId: "c1") == #"{"id":"c1","type":"chat.messages"}"#, "chat.messages body")
    check(try CommandBody.approvalPendingQuery(id: "a1") == #"{"id":"a1","type":"approval.pending"}"#, "pending query")
    check(try CommandBody.approvalDetail(id: "a1", ref: "d-1") == #"{"id":"a1","ref":"d-1","type":"approval.detail"}"#, "detail body with ref")
    fails(ProtocolError.badFormat, "bad ref") { _ = try CommandBody.approvalDetail(id: "a1", ref: "has space") }
    let hash = String(repeating: "ab", count: 32)
    check(try CommandBody.approvalDecide(id: "a1", approve: true, paramsHash: hash) == #"{"approve":true,"id":"a1","paramsHash":"\#(hash)","type":"approval.decide"}"#, "decide body as in PROTOCOL.md")
    fails(ProtocolError.badFormat, "approve needs paramsHash") { _ = try CommandBody.approvalDecide(id: "a1", approve: true, paramsHash: nil) }
    check(try CommandBody.approvalDecide(id: "a1", approve: false, paramsHash: nil) == #"{"approve":false,"id":"a1","type":"approval.decide"}"#, "deny without hash")

    // Approvals: a cut-short preview needs the full view, and approves its hash.
    let id = "0b9c7b1e-2f43-4a7e-9a55-1d2c3b4a5f60"
    let list = try ApprovalSummary.list(from: try JSONSerialization.jsonObject(with: json(#"{"approvals":[{"id":"\#(id)","toolName":"email.send","paramsHash":"\#(hash)","truncated":true,"fullViewRequired":true,"paramsPreview":{"to":"[object]"}},{"id":"b","toolName":"t","paramsHash":"\#(hash)","truncated":false,"fullViewRequired":false}]}"#)))
    check(list.count == 2 && list[0].needsFullView && !list[1].needsFullView, "list reads fullViewRequired / truncated")
    check(try ApprovalFlow.start(list[1], approve: true) == .decide(body: try CommandBody.approvalDecide(id: "b", approve: true, paramsHash: hash)), "full preview approves directly")
    check(try ApprovalFlow.start(list[0], approve: true) == .fetchFullView(body: try CommandBody.approvalDetail(id: id)), "cut-short preview fetches the full view")
    check(try ApprovalFlow.start(list[0], approve: false) == .decide(body: try CommandBody.approvalDecide(id: id, approve: false, paramsHash: hash)), "deny needs no full view")
    if case .decideOnComputer = try ApprovalFlow.start(ApprovalSummary(id: "c", toolName: "t", paramsHash: nil, truncated: false, fullViewRequired: false), approve: true) { check(true, "no hash: decide on the computer") } else { check(false, "no hash: decide on the computer") }

    let fullHash = String(repeating: "cd", count: 32)
    let detailData = try JSONSerialization.jsonObject(with: json(#"{"id":"\#(id)","toolName":"email.send","category":"email","agentId":"sara","sessionId":"s1","params":{"to":["a@example.org"],"body":"Full text","token":"***"},"maskedFields":["token"],"runScope":null,"requestedAt":1800000000000,"paramsHash":"\#(fullHash)"}"#))
    guard case .showFullView(let d) = ApprovalFlow.afterDetail(ok: true, data: detailData, error: nil, askedId: id) else { check(false, "detail shows"); return }
    check(d.paramsText.contains("\"body\" : \"Full text\"") && d.paramsText.contains("a@example.org") && d.maskedFields == ["token"], "full params shown")
    check(try ApprovalFlow.approveBody(d) == (try CommandBody.approvalDecide(id: id, approve: true, paramsHash: fullHash)), "approve with the full view's paramsHash")
    if case .decideOnComputer = ApprovalFlow.afterDetail(ok: true, data: detailData, error: nil, askedId: "other-id") { check(true, "detail for another approval refused") } else { check(false, "detail for another approval refused") }
    for code in ["full_view_unavailable", "too_large", "full_view_required", "not_pending", "internal_error"] {
        if case .decideOnComputer(let m) = ApprovalFlow.afterDetail(ok: false, data: nil, error: code, askedId: id) {
            check(m == CommandFailure.message(for: code), "\(code) after detail")
        } else { check(false, "\(code) after detail") }
    }
    fails(ProtocolError.badFormat, "bad paramsHash in the list") {
        _ = try ApprovalSummary(json: ["id": "x", "toolName": "t", "paramsHash": "ABC"])
    }
}

// MARK: - pairing lifetime

func computerRecord(_ lifetime: PairingLifetime, computer: SoftwareIdentitySigner = SoftwareIdentitySigner(), phoneId: String = id32(), notifyKey: Data = crypto.randomBytes(32)) -> PairedComputer {
    PairedComputer(computerId: computer.deviceId, computerName: nil, computerKey: computer.publicKeySPKI, relay: nil,
                   localAddresses: ["10.0.0.2:41521"], phoneId: phoneId, notifyKey: notifyKey, pairedAt: now, lifetime: lifetime)
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
    // Tasks › Board: open a chat in the Chat tab (phone board P48); only a real chat id passes.
    check(try BridgeMessageParser.parse(["type": "chat.open", "id": "chat-12345678"]) == .openChat(id: "chat-12345678"), "chat.open")
    fails(BridgeError.invalidField("id"), "chat.open with a script") { _ = try BridgeMessageParser.parse(["type": "chat.open", "id": "x';alert(1)//"]) }
    fails(BridgeError.invalidField("id"), "chat.open short id") { _ = try BridgeMessageParser.parse(["type": "chat.open", "id": "abc"]) }
    fails(BridgeError.invalidField("id"), "chat.open missing id") { _ = try BridgeMessageParser.parse(["type": "chat.open"]) }
    fails(BridgeError.unexpectedField("x"), "chat.open extra field") { _ = try BridgeMessageParser.parse(["type": "chat.open", "id": "chat-12345678", "x": 1]) }
    check(!BridgeGate.allows(.openChat(id: "chat-12345678"), unlocked: false), "chat.open refused while locked")

    // Bridge gate: origin and lock state.
    check(BridgeGate.allowsOrigin(scheme: "girru-app", host: "computer", isMainFrame: true), "core-ui origin")
    check(!BridgeGate.allowsOrigin(scheme: "girru-app", host: "computer", isMainFrame: false), "core-ui subframe refused")
    check(!BridgeGate.allowsOrigin(scheme: "http", host: "192.168.1.20", isMainFrame: true), "LAN http page refused")
    check(!BridgeGate.allowsOrigin(scheme: "https", host: "computer", isMainFrame: true), "https refused")
    check(!BridgeGate.allowsOrigin(scheme: "girru-app", host: "other", isMainFrame: true), "other host refused")
    check(!BridgeGate.allowsOrigin(scheme: "file", host: "", isMainFrame: true), "fallback file has no bridge")
    let all: [BridgeRequest] = [.lockState, .authenticate(reason: "x"), .scanQR, .pushPermission(request: true), .pushPermission(request: false)]
    check(all.allSatisfy { BridgeGate.allows($0, unlocked: true) }, "everything while unlocked")
    check(BridgeGate.allows(.lockState, unlocked: false), "lock.state while locked")
    check(all.dropFirst().allSatisfy { !BridgeGate.allows($0, unlocked: false) }, "nothing else while locked")

    let policy = NavigationPolicy(paired: true, fallbackPage: URL(fileURLWithPath: "/app/NotPaired.html"))
    func d(_ s: String, main: Bool = true, user: Bool = false) -> NavigationDecision { policy.decide(URL(string: s)!, isMainFrame: main, userInitiated: user) }
    check(d("girru-app://computer/chat") == .allow, "core-ui through the scheme handler")
    check(d("GIRRU-APP://Computer/x", main: false) == .allow, "case-insensitive core-ui origin")
    check(d("girru-app://other/") == .deny, "other host on our scheme")
    check(d("girru-app://computer:8080/") == .deny, "port on our scheme")
    check(d("http://192.168.1.20:41522/chat") == .deny, "plain http never loads in the app")
    check(d("http://192.168.1.20:41522/chat", user: true) == .openExternally, "tapped http link goes to Safari")
    check(d("https://computer.local/", main: false, user: true) == .deny, "https frame refused")
    let unpaired = NavigationPolicy(paired: false, fallbackPage: nil)
    check(unpaired.decide(URL(string: "girru-app://computer/")!, isMainFrame: true, userInitiated: false) == .deny, "no core-ui before pairing")
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

// MARK: - verified approvals (notification buttons)

func checkVerifiedApprovals() throws {
    var v = VerifiedApprovals()
    v.record(NoticeContent(kind: .approval, title: "t", body: "b", approvalId: "a-1"), now: now)
    v.record(NoticeContent(kind: .approvalSensitive, title: "t", body: "b", approvalId: "a-2"), now: now)
    v.record(NoticeContent(kind: .summary, title: "3 tasks finished", body: "b"), now: now)
    check(v.entries.count == 2, "only approvals are recorded")
    check(v.take("forged-id", now: now) == nil, "unknown id (forged push) is not acted on")
    check(v.take("a-1", now: now)?.sensitive == false, "normal approval")
    check(v.take("a-1", now: now) == nil, "one button press acts once")
    check(v.take("a-2", now: now)?.sensitive == true, "sensitive comes from the verified kind")

    var old = VerifiedApprovals()
    old.record(NoticeContent(kind: .approval, title: "t", body: "b", approvalId: "a-3"), now: now)
    check(old.take("a-3", now: now.addingTimeInterval(VerifiedApprovals.lifetime + 1)) == nil, "too old is ignored")

    var many = VerifiedApprovals()
    for i in 0..<40 {
        many.record(NoticeContent(kind: .approval, title: "t", body: "b", approvalId: "id-\(i)"), now: now.addingTimeInterval(TimeInterval(i)))
    }
    check(many.entries.count == VerifiedApprovals.maxEntries, "bounded size")
    check(many.take("id-0", now: now.addingTimeInterval(40)) == nil && many.take("id-39", now: now.addingTimeInterval(40)) != nil, "oldest dropped first")
    check(try JSONDecoder().decode(VerifiedApprovals.self, from: try JSONEncoder().encode(v)) == v, "persists")
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

// MARK: - relay hello

func checkRelayHello() throws {
    let signer = SoftwareIdentitySigner()
    let relay = "wss://relay.girru.net/v1"
    let nonce = id32()
    let challenge: [String: Any] = ["t": "challenge", "v": 1, "relay": relay, "nonce": nonce]
    let hello = try RelayFrames.hello(challenge: challenge, configured: relay, signer: signer, allow: ["a"])
    check(hello["t"] as? String == "hello" && hello["v"] as? Int == 1, "hello frame")
    check(hello["key"] as? String == Base64URL.encode(signer.publicKeySPKI), "hello carries the identity key")
    check(hello["allow"] as? [String] == ["a"] && (hello["pairing"] as? [String])?.isEmpty == true, "allow list; a phone opens no pairing ids")
    let sig = Base64URL.decode(hello["sig"] as? String ?? "") ?? Data()
    check(crypto.verify(signature: sig, message: Data("girru/relay/v1/hello\n\(relay)\n\(nonce)".utf8), publicKeySPKI: signer.publicKeySPKI),
          "hello signs the relay name and the nonce")
    var other = challenge
    other["relay"] = "wss://evil.example/v1"
    fails(RelayError.wrongRelay, "a challenge from another relay") { _ = try RelayFrames.hello(challenge: other, configured: relay, signer: signer, allow: []) }
    var short = challenge
    short["nonce"] = "abc"
    fails(ProtocolError.badFormat, "a nonce that is not 32 bytes") { _ = try RelayFrames.hello(challenge: short, configured: relay, signer: signer, allow: []) }
    let msg = RelayFrames.message(["t": "msg", "from": "x", "env": "g1.pchal.a.b"])
    check(msg?.from == "x" && msg?.env == "g1.pchal.a.b", "msg frame read")
    check(RelayFrames.message(["t": "drop", "reason": "offline"]) == nil, "only msg frames carry envelopes")
}

// MARK: - chat page bridge + native screens

func checkPageBridge() throws {
    check(PageBridge.classify(method: "GET", path: "/") == .file(path: "/"), "the page itself")
    check(PageBridge.classify(method: "GET", path: "/assets/app-1.js?v=2") == .file(path: "/assets/app-1.js"), "a query never names a file")
    check(PageBridge.classify(method: "POST", path: "/chat") == .refuse(status: 405), "files are GET only")
    check(PageBridge.classify(method: "GET", path: "/api/chat/conversations") == .api(method: "GET", path: "/api/chat/conversations"), "an API request")
    check(PageBridge.classify(method: "post", path: "/api/chat/conversations/a1/runs") == .api(method: "POST", path: "/api/chat/conversations/a1/runs"), "methods are upper-cased")
    check(PageBridge.classify(method: "GET", path: "/api/chat/runs/run-abcdefgh/events?after=4") == .stream(path: "/api/chat/runs/run-abcdefgh/events?after=4"), "run events stream")
    check(PageBridge.classify(method: "POST", path: "/api/chat/runs/run-abcdefgh/events") == .api(method: "POST", path: "/api/chat/runs/run-abcdefgh/events"), "only GET streams")
    check(PageBridge.classify(method: "GET", path: "/api/terminal/sessions/0b8a1c4e-0000-4000-8000-000000000001/stream?after=7") == .stream(path: "/api/terminal/sessions/0b8a1c4e-0000-4000-8000-000000000001/stream?after=7"), "a terminal's output streams too")
    check(PageBridge.classify(method: "GET", path: "/api/terminal/sessions") == .api(method: "GET", path: "/api/terminal/sessions"), "the terminal list is a request")
    check(PageBridge.classify(method: "TRACE", path: "/api/auth/me") == .refuse(status: 400), "unknown methods refused")
    check(PageBridge.classify(method: "GET", path: "relative") == .refuse(status: 400), "paths start with /")

    check(try PageBridge.jsonBody(nil) == nil && PageBridge.jsonBody(Data()) == nil, "no body")
    check((try PageBridge.jsonBody(Data(#"{"title":"x"}"#.utf8)) as? [String: Any])?["title"] as? String == "x", "JSON body")
    fails(PageError.badBody, "a body that is not JSON") { _ = try PageBridge.jsonBody(Data("a=b".utf8)) }
    fails(PageError.tooLarge, "a body over 256 KiB") { _ = try PageBridge.jsonBody(Data(repeating: 0x20, count: PageBridge.maxBody + 1)) }

    let ok = PageBridge.apiResponse(ok: true, data: ["status": 201, "body": ["id": "c1"]], error: nil)
    check(ok.status == 201 && ok.headers["Content-Type"]?.hasPrefix("application/json") == true, "api answer status and type")
    check((try JSONSerialization.jsonObject(with: ok.body) as? [String: Any])?["id"] as? String == "c1", "api answer body")
    check(PageBridge.apiResponse(ok: true, data: ["status": 400, "body": NSNull()], error: nil).body == Data("null".utf8), "null body")
    check(PageBridge.apiResponse(ok: false, data: nil, error: "not_allowed").status == 403, "not_allowed is 403")
    check(PageBridge.apiResponse(ok: false, data: nil, error: "rate_limited").status == 429, "rate_limited is 429")
    check(PageBridge.apiResponse(ok: false, data: nil, error: "internal_error").status == 503, "anything else is 503")
    check(PageBridge.apiResponse(ok: true, data: ["status": 9000], error: nil).status == 502, "a strange status fails closed")

    let a = Data("hello ".utf8), b = Data("world".utf8)
    let p0 = try PageBridge.filePart(["status": 200, "type": "text/javascript", "parts": 2, "part": 0, "size": 11, "build": "build-1", "body": a.base64EncodedString()])
    let p1 = try PageBridge.filePart(["status": 200, "type": "text/javascript", "parts": 2, "part": 1, "size": 11, "build": "build-1", "body": b.base64EncodedString()])
    let whole = try PageBridge.assemble([p0, p1])
    check(whole.status == 200 && whole.body == Data("hello world".utf8) && whole.headers["Content-Type"] == "text/javascript", "parts put together")
    var other = p1; other.build = "build-2"
    fails(PageError.badAnswer, "parts of two builds") { _ = try PageBridge.assemble([p0, other]) }
    fails(PageError.badAnswer, "a missing part") { _ = try PageBridge.assemble([p0]) }
    fails(PageError.badAnswer, "parts out of order") { _ = try PageBridge.assemble([p1, p0]) }
    check(try PageBridge.assemble([PageBridge.filePart(["status": 404, "build": "build-1"])]).status == 404, "not found passes through")
    fails(PageError.badAnswer, "too many parts") { _ = try PageBridge.filePart(["status": 200, "type": "x", "parts": 500, "part": 0, "size": 1, "build": "b", "body": ""]) }

    check(String(decoding: PageBridge.sse(["seq": 3, "type": "text", "content": "Hi"]), as: UTF8.self) == "id: 3\ndata: {\"content\":\"Hi\",\"seq\":3,\"type\":\"text\"}\n\n", "a numbered event")
    check(!String(decoding: PageBridge.sse(["seq": 0, "type": "preview", "content": "H"]), as: UTF8.self).contains("id:"), "a preview has no id")
    check(String(decoding: PageBridge.sse(["seq": 4, "data": "hi"], event: "output"), as: UTF8.self) == "event: output\ndata: {\"data\":\"hi\",\"seq\":4}\n\n", "a terminal event keeps its name")
    if case let .stream(_, _, event) = try ComputerMessage.parse(Data(#"{"type":"stream","ref":"t1","event":"exit","data":{"exitCode":0}}"#.utf8)) {
        check(event == "exit", "terminal stream event read")
    } else { check(false, "terminal stream event read") }

    // Stream messages from the computer.
    if case let .stream(ref, data, event) = try ComputerMessage.parse(Data(#"{"type":"stream","ref":"s1","data":{"seq":1,"type":"text"}}"#.utf8)) {
        check(ref == "s1" && data["type"] as? String == "text" && event == nil, "stream frame read")
    } else { check(false, "stream frame read") }
    if case let .streamEnd(_, complete) = try ComputerMessage.parse(Data(#"{"type":"stream.end","ref":"s1","status":"dropped"}"#.utf8)) {
        check(!complete, "a dropped stream is not complete")
    } else { check(false, "stream.end read") }
    fails(ProtocolError.badFormat, "a stream frame without data") { _ = try ComputerMessage.parse(Data(#"{"type":"stream","ref":"s1"}"#.utf8)) }

    let call = try CommandBody.apiCall(method: "POST", path: "/api/chat/conversations", body: ["title": "x"], ref: "p1")
    check(call == #"{"body":{"title":"x"},"method":"POST","path":"/api/chat/conversations","ref":"p1","type":"api.call"}"#, "api.call body")
    check(try CommandBody.uiGet(path: "/", part: 0, ref: "f1") == #"{"path":"/","ref":"f1","type":"ui.get"}"#, "ui.get first part")
    check(TerminalUse.of(method: "POST", path: "/api/terminal/sessions") == .open, "opening a terminal needs the check")
    check(TerminalUse.of(method: "GET", path: "/api/terminal") == .none && TerminalUse.of(method: "GET", path: "/api/terminal/prefs") == .none, "settings need no check")
    check(TerminalUse.of(method: "GET", path: "/api/terminal/sessions/abc/stream?after=3") == .session("abc"), "reading one terminal")
    check(TerminalUse.of(method: "POST", path: "/api/terminal/sessions/abc/input") == .session("abc"), "typing into one terminal")
    check(TerminalUse.of(method: "GET", path: "/api/chat/conversations") == .none, "chat is not the terminal")
    check(try CommandBody.uiGet(path: "/a.js", part: 2, ref: "f1") == #"{"part":2,"path":"/a.js","ref":"f1","type":"ui.get"}"#, "ui.get later part")
}

func checkPhoneScreens() throws {
    let team = try TeamMember.list(from: ["agents": [
        ["id": "main", "name": "Girru", "primary": true, "department": NSNull()],
        ["id": "sara", "name": "Sara", "primary": false, "department": "marketing"],
        ["id": "karim", "name": "Karim", "primary": false, "role": "specialist", "department": "writing"],
        ["id": "lina", "name": "Lina", "primary": false, "department": "support"],
        ["name": "no id"],
    ]])
    check(team.count == 4, "agents without an id are skipped")
    let running = try TaskItem.list(from: ["runs": [
        ["id": "chat:1", "title": "Landing page copy", "agentId": "karim", "agentName": "Karim", "needsYou": false, "link": [:], "startedAt": "2026-11-03T10:00:00.000Z"],
        ["id": "task:2", "title": "Clean the inbox", "agentId": "main", "agentName": "Girru", "needsYou": false, "link": ["sessionId": "s2"]],
    ]])
    check(running.count == 2 && running[0].startedAt != nil && running[1].sessionId == "s2", "tasks read")
    let approvals = try ApprovalCard.list(from: ["approvals": [
        ["id": "a1", "toolName": "send_email", "agentId": "sara", "paramsPreview": ["to": "sales@girru.dev", "subject": "Sales this week", "attachment": ["name": "x"]], "requestedAt": "2026-11-03T10:00:00Z"],
    ]])
    check(approvals.first?.title(agentName: "Sara") == "Sara wants to send an email", "approval title in plain words")
    check(approvals.first?.lines.map(\.0) == ["Attachment", "Subject", "To"] && approvals.first?.lines.first?.1 == "…", "preview lines; nested values are not shown")
    let board = TeamBoard.members(team, running: running, approvals: approvals)
    check(board.map(\.id) == ["main", "sara", "karim", "lina"], "main first, then needs you, working, free")
    check(board[0].status == .working && board[0].subtitle == "Main agent · Clean the inbox", "main agent working")
    check(board[1].status == .needsYou && board[1].subtitle == "Marketing · waiting for your OK", "needs you")
    check(board[3].status == .free && board[3].subtitle == "Support", "free")
    check(TeamBoard.chips(board) == ["All", "Needs you", "Marketing", "Writing", "Support"], "chips")
    check(TeamBoard.filter(board, chip: "Writing", query: "").map(\.id) == ["karim"], "department chip")
    check(TeamBoard.filter(board, chip: "All", query: "spec").map(\.id) == ["karim"], "search by job")
    check(TeamBoard.filter(board, chip: "Needs you", query: "").map(\.id) == ["sara"], "needs you chip")

    let schedules = try ScheduleItem.list(from: ["schedules": [
        ["id": "job:1", "title": "Weekly", "when": "Every Monday at 9:00", "enabled": true, "nextRun": "2026-11-09T09:00:00Z"],
        ["id": "job:2", "title": "Paused", "when": "Every day", "enabled": false, "nextRun": NSNull()],
        ["id": "job:3", "title": "Daily backup", "when": "Every day at 2:00", "enabled": true, "nextRun": "2026-11-04T02:00:00Z"],
    ]])
    check(schedules.map(\.id) == ["job:3", "job:1", "job:2"], "soonest first, paused last")
    check(PhoneText.action("web.publish_page") == "publish a page" && PhoneText.action("delete_files") == "delete files" && PhoneText.action("run") == "use run", "tool names as actions")
    check(PhoneText.title("sales_ops") == "Sales ops", "department names")
    check(try CommandBody.tasksList(place: "running") == #"{"place":"running","type":"tasks.list"}"#, "tasks.list body")
}

let groups: [(String, () throws -> Void)] = [
    ("base64url", checkBase64), ("crypto", checkCrypto), ("session", checkSession), ("commands", checkCommands),
    ("replay window", checkReplayWindow), ("QR payload", checkPayload), ("pairing messages", checkPairingMessages),
    ("reference vectors", checkReferenceVectors), ("pairing progress", checkPairingProgress), ("session messages + approvals", checkSessionMessages),
    ("pairing lifetime", checkLifetime), ("lock policy", checkLock), ("bridge + navigation", checkBridge), ("notices", checkNotices),
    ("verified approvals", checkVerifiedApprovals), ("relay hello", checkRelayHello), ("chat page bridge", checkPageBridge), ("phone screens", checkPhoneScreens),
]
for (name, run) in groups {
    do { try run() } catch {
        print("FAIL \(name): threw \(error)")
        failures += 1
    }
}
print("\(passes) passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)
