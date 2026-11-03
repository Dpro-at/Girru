// The iPhone's pairing code against a real computer and relay
// (packages/mobile/tools/pair-harness.mjs). Same GirruCore types the app uses:
// PairingPayloadParser, PairingProgress, RelayPairingLink; only the identity is a
// software key (no Secure Enclave on a Mac).
//
// From packages/backend:
//   node --import tsx ../mobile/tools/pair-harness.mjs swift run --package-path ../mobile/ios PairCheck
import Foundation
import GirruCore

/// Trusts exactly the harness's throwaway certificate for localhost, nothing else.
final class TestCertificateTrust: NSObject, URLSessionDelegate {
    let certificate: Data

    init(pem: String) {
        let body = pem.split(separator: "\n").filter { !$0.hasPrefix("-----") }.joined()
        certificate = Data(base64Encoded: body) ?? Data()
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first,
              SecCertificateCopyData(leaf) as Data == certificate
        else { return completionHandler(.cancelAuthenticationChallenge, nil) }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("PairCheck: \(message)\n".utf8))
    exit(1)
}

// The harness reads stdout line by line through a pipe.
setvbuf(stdout, nil, _IOLBF, 0)

guard let qr = CommandLine.arguments.last, qr.hasPrefix("girru://") else { fail("pass the QR text as the last argument") }
guard let caPath = ProcessInfo.processInfo.environment["GIRRU_TEST_CA"], let pem = try? String(contentsOfFile: caPath, encoding: .utf8) else {
    fail("GIRRU_TEST_CA must name the harness certificate")
}

let crypto = CryptoKitPairingCrypto()
let signer = SoftwareIdentitySigner()
let session = URLSession(configuration: .ephemeral, delegate: TestCertificateTrust(pem: pem), delegateQueue: nil)
let link = RelayPairingLink(session: session)

do {
    let payload = try PairingPayloadParser.parse(qr, crypto: crypto)
    var progress = PairingProgress(payload: payload, phoneKey: signer.publicKeySPKI)
    print("id=\(progress.phoneId)")
    let request = PairingRequest(key: Base64URL.encode(signer.publicKeySPKI), name: "PairCheck iPhone", platform: "ios", push: nil, lifetimeDays: 30)
    let sealed = try progress.requestText(request, signer: signer, crypto: crypto)
    try await link.send(request: sealed, to: payload, signer: signer)
    guard let challenge = try await link.awaitChallenge(for: payload, until: payload.expiresAt) else { fail("no challenge before the code expired") }
    let code = try progress.receiveChallenge(challenge, crypto: crypto)
    print("code=\(code)")
    let welcomeText = try await link.awaitWelcome(for: payload)
    let welcome = try progress.receiveWelcome(welcomeText, phone: signer, crypto: crypto)
    guard welcome.computer == payload.computerId, welcome.phone == progress.phoneId, welcome.lifetimeDays == 30 else { fail("welcome fields") }
    print("paired")
    await link.close()

    // The session (MOB-LINK-01): handshake, signed commands, sealed replies, live run frames.
    guard let notifyKey = Base64URL.decode(welcome.notifyKey), let lifetime = PairingLifetime(days: welcome.lifetimeDays) else { fail("welcome key") }
    let computer = PairedComputer(computerId: payload.computerId, computerName: welcome.name, computerKey: payload.computerKey, relay: payload.relay,
                                  localAddresses: payload.localAddresses, phoneId: progress.phoneId, notifyKey: notifyKey, pairedAt: Date(), lifetime: lifetime)
    let sessionLink = SessionLink(computer: computer, urlSession: session)
    try await sessionLink.connect(signer: signer)
    print("session")
    let commands = CommandSigner(signer: signer, counter: MonotonicCounter(store: InMemoryCounterStore()), crypto: crypto)

    let list = try await sessionLink.call(commands.sign(body: try CommandBody.make("chat.list", ref: "c1"), to: computer.computerId))
    guard list.ok, (list.data as? [String: Any])?["conversations"] is [Any] else { fail("chat.list: \(list.error ?? "no list")") }
    print("chat.list ok")
    let team = try await sessionLink.call(commands.sign(body: try CommandBody.make("team.list", ref: "t1"), to: computer.computerId))
    guard team.ok, let agents = (team.data as? [String: Any])?["agents"] as? [[String: Any]], let agent = agents.first?["id"] as? String else { fail("team.list: \(team.error ?? "no agents")") }
    print("team.list ok (\(agents.count) agents)")

    // A turn with that agent: the reply, then its run frames until run.end.
    let frames = AsyncStream<RunEvent>.makeStream()
    let send = try await sessionLink.call(commands.sign(body: try CommandBody.make("chat.send", ["message": "Hi from PairCheck", "agentId": agent], ref: "s1"), to: computer.computerId),
                                          runs: { frames.continuation.yield($0) })
    guard send.ok else { fail("chat.send: \(send.error ?? "")") }
    var text = ""
    for await event in frames.stream {
        if case let .frame(_, _, frame) = event, frame["type"] as? String == "text" { text += frame["content"] as? String ?? "" }
        if case let .end(_, end, _) = event {
            guard end == .complete else { fail("run ended \(end)") }
            break
        }
    }
    guard text.contains("Hello from the computer") else { fail("run text: \(text)") }
    print("chat.send streamed: \(text)")

    // The same signed command again is refused as a replay, answered by its nonce.
    let once = try commands.sign(body: try CommandBody.make("chat.list"), to: computer.computerId)
    _ = try await sessionLink.call(once)
    let again = try await sessionLink.call(once)
    guard !again.ok, again.error == "replay" else { fail("replay not refused: \(again)") }
    print("replay refused")
    await sessionLink.close()
    exit(0)
} catch {
    fail("\(error)")
}
