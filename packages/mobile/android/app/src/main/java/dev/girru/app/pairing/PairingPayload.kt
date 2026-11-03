package dev.girru.app.pairing

import dev.girru.app.crypto.G1
import java.net.URLDecoder

/**
 * The computer's QR code (PROTOCOL.md "QR code"):
 *
 *   girru://pair?v=1&cid=…&ck=…&pid=p_…&ps=…&exp=<unix seconds>&relay=wss://<host>/v1&lan=h:p,…&name=…
 *
 * "Type the code instead" accepts the same text; whitespace and line breaks
 * are ignored so it can be pasted or typed in groups.
 */
class PairingPayload(
    val computerId: String,
    val computerKey: ByteArray,
    val pairingId: String,
    val secret: ByteArray,
    val relayUrl: String?,
    val localAddresses: List<String>,
    val expiresAtSec: Long,
    val computerName: String,
)

object PairingPayloadParser {
    const val PREFIX = "girru://pair?"
    const val MAX_BYTES = 1024
    const val MAX_LOCAL_ADDRESSES = 4
    /** Ten minutes from the protocol, plus one minute for clock difference. */
    const val MAX_AHEAD_SEC = 11 * 60L
    const val DEFAULT_NAME = "Your computer"

    enum class Reason { NOT_A_GIRRU_CODE, TOO_LONG, UNSUPPORTED_VERSION, MISSING_FIELD, BAD_FIELD, WRONG_KEY, EXPIRED, NO_ROUTE }

    sealed class Result {
        class Ok(val payload: PairingPayload) : Result()
        class Error(val reason: Reason) : Result()
    }

    val PAIRING_ID = Regex("^p_[A-Za-z0-9_-]{43}$")
    private val RELAY = Regex("^wss://[A-Za-z0-9.:\\[\\]-]{1,253}/v1$")
    private val FIELD_NAME = Regex("^[a-z]{1,16}$")
    private val LABEL = Regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")

    fun parse(input: String, nowSec: Long): Result {
        val text = input.filterNot { it.isWhitespace() }
        if (text.toByteArray(Charsets.UTF_8).size > MAX_BYTES) return Result.Error(Reason.TOO_LONG)
        if (!text.startsWith(PREFIX, ignoreCase = true)) return Result.Error(Reason.NOT_A_GIRRU_CODE)
        val fields = HashMap<String, String>()
        for (part in text.substring(PREFIX.length).split('&')) {
            val eq = part.indexOf('=')
            if (eq <= 0) return Result.Error(Reason.BAD_FIELD)
            val key = part.substring(0, eq)
            if (!FIELD_NAME.matches(key)) return Result.Error(Reason.BAD_FIELD)
            // A repeated field makes the code invalid; unknown fields are ignored.
            if (fields.containsKey(key)) return Result.Error(Reason.BAD_FIELD)
            fields[key] = try {
                URLDecoder.decode(part.substring(eq + 1), "UTF-8")
            } catch (e: IllegalArgumentException) {
                return Result.Error(Reason.BAD_FIELD)
            }
        }

        val version = fields["v"] ?: return Result.Error(Reason.MISSING_FIELD)
        if (version != "1") return Result.Error(Reason.UNSUPPORTED_VERSION)

        val computerId = fields["cid"] ?: return Result.Error(Reason.MISSING_FIELD)
        if (!G1.isDeviceId(computerId)) return Result.Error(Reason.BAD_FIELD)
        val key = G1.fromB64url(fields["ck"] ?: return Result.Error(Reason.MISSING_FIELD))
            ?: return Result.Error(Reason.BAD_FIELD)
        if (G1.p256PublicKey(key) == null) return Result.Error(Reason.BAD_FIELD)
        // Checked before either value is trusted: the id is the key's own hash.
        if (G1.deviceIdOf(key) != computerId) return Result.Error(Reason.WRONG_KEY)

        val pairingId = fields["pid"] ?: return Result.Error(Reason.MISSING_FIELD)
        if (!PAIRING_ID.matches(pairingId)) return Result.Error(Reason.BAD_FIELD)
        val secret = G1.fromB64url(fields["ps"] ?: return Result.Error(Reason.MISSING_FIELD))
            ?: return Result.Error(Reason.BAD_FIELD)
        if (secret.size != 32) return Result.Error(Reason.BAD_FIELD)

        val exp = (fields["exp"] ?: return Result.Error(Reason.MISSING_FIELD)).toLongOrNull()
            ?: return Result.Error(Reason.BAD_FIELD)
        if (exp <= nowSec) return Result.Error(Reason.EXPIRED)
        if (exp - nowSec > MAX_AHEAD_SEC) return Result.Error(Reason.BAD_FIELD)

        // Kept exactly as written: the phone compares it with the relay's challenge.
        val relay = fields["relay"]
        if (relay != null && !RELAY.matches(relay)) return Result.Error(Reason.BAD_FIELD)

        val lan = fields["lan"]?.split(',')?.filter { it.isNotEmpty() } ?: emptyList()
        if (lan.size > MAX_LOCAL_ADDRESSES || lan.any { !isLocalAddress(it) }) return Result.Error(Reason.BAD_FIELD)
        if (relay == null && lan.isEmpty()) return Result.Error(Reason.NO_ROUTE)

        val name = fields["name"]?.trim()?.takeIf { it.isNotEmpty() } ?: DEFAULT_NAME
        if (name.length > 64 || name.any { it.isISOControl() }) return Result.Error(Reason.BAD_FIELD)

        return Result.Ok(PairingPayload(computerId, key, pairingId, secret, relay, lan, exp, name))
    }

    /** A private (RFC 1918) or link-local IPv4 address, or a `.local` name, with a port. */
    fun isLocalAddress(address: String): Boolean {
        val colon = address.lastIndexOf(':')
        if (colon <= 0) return false
        val portText = address.substring(colon + 1)
        val port = portText.toIntOrNull() ?: return false
        if (port !in 1..65535 || portText != port.toString()) return false
        val host = address.substring(0, colon).lowercase()
        return isLocalIpv4(host) || isLocalName(host)
    }

    private fun isLocalIpv4(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != 4) return false
        val o = parts.map { p ->
            if (p.isEmpty() || p.length > 3 || !p.all { it in '0'..'9' } || (p.length > 1 && p[0] == '0')) return false
            p.toInt().takeIf { it in 0..255 } ?: return false
        }
        return o[0] == 10 ||
            (o[0] == 172 && o[1] in 16..31) ||
            (o[0] == 192 && o[1] == 168) ||
            (o[0] == 169 && o[1] == 254)
    }

    private fun isLocalName(host: String): Boolean {
        if (!host.endsWith(".local") || host.length > 253) return false
        val labels = host.removeSuffix(".local").split('.')
        return labels.isNotEmpty() && labels.all { LABEL.matches(it) }
    }
}
