import Foundation

/// What the computer's QR code carries (Settings › Phone), PROTOCOL.md
/// "QR code":
///
///     girru://pair?v=1&cid=<computer device id>&ck=<computer SPKI>
///                 &pid=<p_ + pairing id>&ps=<pairing secret>&exp=<unix seconds>
///                 &relay=<wss://host/v1>&lan=<host:port>[,<host:port>…]&name=<name>
public struct PairingPayload: Equatable, Sendable {
    public static let supportedVersion = 1

    public var version: Int
    /// base64url(SHA-256(computerKey)); checked against the key.
    public var computerId: String
    /// The computer's identity public key, SPKI DER. Learned from the screen,
    /// a channel the relay cannot touch.
    public var computerKey: Data
    /// "p_" + 32 random bytes as base64url: a temporary mailbox on the relay.
    /// The full text, prefix included, is the pairing key's HKDF salt.
    public var pairingId: String
    /// 32 random bytes; the pairing key is derived from it.
    public var pairingSecret: Data
    public var expiresAt: Date
    /// Exactly as in the QR code; compared byte for byte with the relay's challenge.
    public var relay: String?
    public var localAddresses: [String]
    public var computerName: String?
}

public enum PairingPayloadError: Error, Equatable {
    case notAGirruCode
    case unsupportedVersion
    case missingField(String)
    case invalidField(String)
    case duplicateField(String)
    case expired
    case noRoute
}

public enum PairingPayloadParser {
    public static let maxLength = 1024
    /// PROTOCOL.md: a QR code is valid for at most 10 minutes.
    public static let maxLifetime: TimeInterval = 10 * 60
    public static let maxLocalAddresses = 4

    public static func parse(_ text: String, crypto: PairingCrypto, now: Date = Date()) throws -> PairingPayload {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.utf8.count <= maxLength,
              let comps = URLComponents(string: trimmed),
              comps.scheme?.lowercased() == "girru",
              comps.host?.lowercased() == "pair" else { throw PairingPayloadError.notAGirruCode }

        var fields: [String: String] = [:]
        for item in comps.queryItems ?? [] {
            guard fields[item.name] == nil else { throw PairingPayloadError.duplicateField(item.name) }
            fields[item.name] = item.value ?? ""
        }
        func required(_ name: String) throws -> String {
            guard let v = fields[name], !v.isEmpty else { throw PairingPayloadError.missingField(name) }
            return v
        }

        guard let version = Int(try required("v")) else { throw PairingPayloadError.invalidField("v") }
        guard version == PairingPayload.supportedVersion else { throw PairingPayloadError.unsupportedVersion }

        let cid = try required("cid")
        guard Base64URL.isId(cid) else { throw PairingPayloadError.invalidField("cid") }
        guard let ck = Base64URL.decode(try required("ck")), crypto.isValidPublicKey(ck, expectedId: cid) else {
            throw PairingPayloadError.invalidField("ck")
        }
        let pid = try required("pid")
        guard PairingId.isValid(pid) else { throw PairingPayloadError.invalidField("pid") }
        guard let ps = Base64URL.decode(try required("ps")), ps.count == 32 else { throw PairingPayloadError.invalidField("ps") }

        guard let expSeconds = TimeInterval(try required("exp")), expSeconds.isFinite else { throw PairingPayloadError.invalidField("exp") }
        let exp = Date(timeIntervalSince1970: expSeconds)
        guard exp > now else { throw PairingPayloadError.expired }
        guard exp.timeIntervalSince(now) <= maxLifetime else { throw PairingPayloadError.invalidField("exp") }

        var relay: String?
        if let r = fields["relay"], !r.isEmpty {
            guard RelayName.isValid(r) else { throw PairingPayloadError.invalidField("relay") }
            relay = r
        }

        var lan: [String] = []
        if let l = fields["lan"], !l.isEmpty {
            lan = l.split(separator: ",").map(String.init)
            guard lan.count <= maxLocalAddresses, lan.allSatisfy(LocalAddress.isPrivate(hostPort:)) else {
                throw PairingPayloadError.invalidField("lan")
            }
        }
        guard relay != nil || !lan.isEmpty else { throw PairingPayloadError.noRoute }

        var name = fields["name"]
        if let n = name {
            guard n.count <= 64, !n.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
                throw PairingPayloadError.invalidField("name")
            }
            if n.isEmpty { name = nil }
        }

        return PairingPayload(version: version, computerId: cid, computerKey: ck, pairingId: pid, pairingSecret: ps,
                              expiresAt: exp, relay: relay, localAddresses: lan, computerName: name)
    }
}

/// A pairing id: "p_" + 43 base64url characters (32 bytes). The prefix keeps
/// it apart from device ids; the relay refuses any other form.
public enum PairingId {
    public static func isValid(_ text: String) -> Bool {
        text.hasPrefix("p_") && Base64URL.isId(String(text.dropFirst(2)))
    }
}

/// A relay name: exactly `wss://<host>/v1`, as the relay states it in its
/// challenge. Kept as text and compared byte for byte, because the relay hello
/// is bound to it.
public enum RelayName {
    /// Same character rule as the relay's own name pattern, but TLS only: the
    /// phone never accepts a plain `ws://` relay. The host part may carry a
    /// port or a bracketed IPv6 address; no user info, path, query or fragment.
    public static func isValid(_ text: String) -> Bool {
        guard text.hasPrefix("wss://"), text.hasSuffix("/v1") else { return false }
        let host = text.dropFirst(6).dropLast(3)
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.:[]-")
        return (1...253).contains(host.count) && host.allSatisfy { allowed.contains($0) }
    }

    /// The device refuses a challenge from any relay but the one it was given.
    public static func challengeMatches(_ challengeRelay: String, configured: String) -> Bool {
        challengeRelay == configured
    }
}

/// The text under the QR code for "Type the code instead". PROTOCOL.md has no
/// typed-code path yet (a typed code cannot carry the computer's key), so the
/// app only checks the form; the exchange waits for a protocol addition.
public enum PairingCode {
    public static let length = 12
    private static let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    /// Normalized Crockford base32, or nil. Accepts lower case, spaces, dashes
    /// and the usual look-alikes (O→0, I/L→1).
    public static func normalize(_ input: String) -> String? {
        var out = ""
        for ch in input.uppercased() {
            switch ch {
            case " ", "-": continue
            case "O": out.append("0")
            case "I", "L": out.append("1")
            default:
                guard alphabet.contains(ch) else { return nil }
                out.append(ch)
            }
        }
        return out.count == length ? out : nil
    }

    public static func display(_ normalized: String) -> String {
        var groups: [String] = []
        var rest = Substring(normalized)
        while !rest.isEmpty {
            groups.append(String(rest.prefix(4)))
            rest = rest.dropFirst(4)
        }
        return groups.joined(separator: "-")
    }
}

public enum LocalAddress {
    /// True for "host:port" on the owner's own network: private IPv4 ranges,
    /// link-local, IPv6 unique-local / link-local, or a .local name.
    public static func isPrivate(hostPort: String) -> Bool {
        guard let (host, port) = split(hostPort), (1...65535).contains(port) else { return false }
        let lower = host.lowercased()
        if lower.hasSuffix(".local") {
            let label = lower.dropLast(6)
            return !label.isEmpty && label.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "-" || $0 == "." }
        }
        if let v4 = ipv4(lower) {
            switch (v4[0], v4[1]) {
            case (10, _), (192, 168), (169, 254): return true
            case (172, let b) where (16...31).contains(b): return true
            default: return false
            }
        }
        if lower.contains(":") {
            // Prefix check only; the network stack does the full parse.
            return lower.hasPrefix("fd") || lower.hasPrefix("fc") || lower.hasPrefix("fe80:")
        }
        return false
    }

    static func split(_ hostPort: String) -> (String, Int)? {
        if hostPort.hasPrefix("[") {
            guard let close = hostPort.firstIndex(of: "]") else { return nil }
            let host = String(hostPort[hostPort.index(after: hostPort.startIndex)..<close])
            let rest = hostPort[hostPort.index(after: close)...]
            guard rest.hasPrefix(":"), let port = Int(rest.dropFirst()) else { return nil }
            return (host, port)
        }
        let parts = hostPort.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, let port = Int(parts[1]) else { return nil }
        return (String(parts[0]), port)
    }

    static func ipv4(_ s: String) -> [Int]? {
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var out: [Int] = []
        for p in parts {
            guard !p.isEmpty, p.count <= 3, p.allSatisfy({ $0.isASCII && $0.isNumber }), let n = Int(p), n <= 255 else { return nil }
            out.append(n)
        }
        return out
    }
}
