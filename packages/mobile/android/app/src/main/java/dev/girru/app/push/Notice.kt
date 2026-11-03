package dev.girru.app.push

import dev.girru.app.crypto.FlatJson
import dev.girru.app.crypto.G1
import dev.girru.app.crypto.G1Exception
import dev.girru.app.crypto.utf8

/** What a verified notice asks the phone to show. */
class PushNotice(
    val kind: Kind,
    val title: String,
    val body: String,
    val approvalId: String?,
    val group: String?,
) {
    enum class Kind(val wire: String) {
        APPROVAL("approval"),
        APPROVAL_SENSITIVE("approval.sensitive"),
        TASK_FAILED("task.failed"),
        SUMMARY("summary"),
        SECURITY("security");

        val isApproval: Boolean get() = this == APPROVAL || this == APPROVAL_SENSITIVE
    }

    companion object {
        const val MAX_TITLE = 120
        const val MAX_BODY = 600
        val ID = Regex("^[A-Za-z0-9_-]{1,64}$")

        /** Content rules from PROTOCOL.md; null when any is broken. */
        fun from(fields: Map<String, Any?>): PushNotice? {
            val kind = Kind.entries.firstOrNull { it.wire == fields["kind"] } ?: return null
            val title = (fields["title"] as? String)?.takeIf { it.isNotBlank() && it.length <= MAX_TITLE && it.isPlain() }
                ?: return null
            val body = (fields["body"] as? String ?: "").takeIf { it.length <= MAX_BODY && it.isPlain() } ?: return null
            val approvalId = fields["approvalId"]
            if (approvalId != null && (approvalId !is String || !ID.matches(approvalId))) return null
            if (kind.isApproval && approvalId == null) return null
            val group = fields["group"]
            if (group != null && (group !is String || !ID.matches(group))) return null
            return PushNotice(kind, title, body, approvalId as String?, group as String?)
        }

        // Line breaks are allowed; other control characters are not.
        private fun String.isPlain(): Boolean = none { it.isISOControl() && it != '\n' }
    }
}

/**
 * `g1.ntf.<payload>.<sig>` (PROTOCOL.md "Notice format"). Checks, in the
 * protocol's order: signature, from/to, time (±1 hour), tag, content rules.
 * The replay counter is left to the caller and must be checked last.
 */
object NoticeEnvelope {
    const val MAX_CHARS = 3500
    const val MAX_SKEW_MS = 60 * 60 * 1000L

    class Opened(val counter: Long, val notice: PushNotice)

    fun open(
        envelope: String,
        computerSpki: ByteArray,
        computerId: String,
        phoneId: String,
        notifyKey: ByteArray,
        nowMs: Long,
    ): Opened {
        if (envelope.length > MAX_CHARS) throw G1Exception("too_large")
        val parts = envelope.split('.')
        if (parts.size != 4 || parts[0] != G1.SUITE || parts[1] != "ntf") throw G1Exception("bad_format")
        val payload = parts[2]
        val sig = G1.fromB64url(parts[3]) ?: throw G1Exception("bad_signature")
        if (!G1.verify(computerSpki, "girru/v1/ntf\n$payload".utf8, sig)) throw G1Exception("bad_signature")
        val p = FlatJson.read(String(G1.fromB64url(payload) ?: throw G1Exception("bad_format"), Charsets.UTF_8))
            ?: throw G1Exception("bad_format")
        val from = p["from"] as? String
        val to = p["to"] as? String
        if (from != computerId || to != phoneId) throw G1Exception("wrong_target")
        val ctr = p["ctr"] as? Long ?: throw G1Exception("bad_format")
        if (ctr < 1) throw G1Exception("bad_format")
        val ts = p["ts"] as? Long ?: throw G1Exception("bad_format")
        if (kotlin.math.abs(nowMs - ts) > MAX_SKEW_MS) throw G1Exception("stale")
        val box = (p["box"] as? String)?.let { G1.fromB64url(it) } ?: throw G1Exception("bad_format")
        if (box.size < 12 + 16) throw G1Exception("bad_format")
        val plain = G1.aesGcmOpen(
            notifyKey,
            box.copyOfRange(0, 12),
            aad(from, to, ctr),
            box.copyOfRange(12, box.size),
        ) ?: throw G1Exception("bad_tag")
        val fields = FlatJson.read(String(plain, Charsets.UTF_8)) ?: throw G1Exception("bad_format")
        val notice = PushNotice.from(fields) ?: throw G1Exception("bad_content")
        return Opened(ctr, notice)
    }

    fun aad(from: String, to: String, ctr: Long): ByteArray = "girru/v1/ntf\n$from\n$to\n$ctr".utf8
}

/**
 * Approval ids the phone received in a verified notice, with their kind.
 * Approve / Deny act only on an id found here, never on raw intent extras.
 * Kept in the encrypted store; at most [MAX] entries, oldest dropped first.
 */
object VerifiedApprovals {
    const val MAX = 50

    fun encode(entries: Map<String, PushNotice.Kind>): String =
        entries.entries.joinToString("\n") { (id, kind) -> "$id ${kind.wire}" }

    fun decode(text: String?): LinkedHashMap<String, PushNotice.Kind> {
        val out = LinkedHashMap<String, PushNotice.Kind>()
        if (text.isNullOrEmpty()) return out
        for (line in text.split('\n')) {
            val space = line.indexOf(' ')
            if (space <= 0) continue
            val id = line.substring(0, space)
            val kind = PushNotice.Kind.entries.firstOrNull { it.wire == line.substring(space + 1) } ?: continue
            if (PushNotice.ID.matches(id) && kind.isApproval) out[id] = kind
        }
        return out
    }

    fun add(entries: LinkedHashMap<String, PushNotice.Kind>, id: String, kind: PushNotice.Kind) {
        require(PushNotice.ID.matches(id) && kind.isApproval) { "not a verified approval" }
        entries.remove(id)
        entries[id] = kind
        while (entries.size > MAX) entries.remove(entries.keys.first())
    }
}
