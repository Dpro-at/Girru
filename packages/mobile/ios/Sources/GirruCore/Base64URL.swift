import Foundation

/// Unpadded base64url (RFC 4648 §5), the text form of every key, id and
/// envelope part in packages/relay/PROTOCOL.md.
public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Strict, like the computer's decoder: only canonical unpadded base64url is
    /// accepted, so one value never has two spellings.
    public static func decode(_ text: String) -> Data? {
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        guard text.allSatisfy({ allowed.contains($0) }), text.count % 4 != 1 else { return nil }
        if text.isEmpty { return Data() }
        var base64 = text
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64), encode(data) == text else { return nil }
        return data
    }

    /// A 32-byte id (device id or pairing id): 43 characters.
    public static func isId(_ text: String) -> Bool {
        text.count == 43 && decode(text)?.count == 32
    }
}
