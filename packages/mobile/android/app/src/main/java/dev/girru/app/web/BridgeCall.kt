package dev.girru.app.web

/**
 * The only calls the web page may make into the app. Each has a fixed name
 * and checked arguments; anything else, or any extra argument, is refused.
 *
 * Wire form (posted to `window.girruNative`):
 *   request  {"id": "<1-64 of A-Z a-z 0-9 _ ->", "method": "<name>", "args": {...}}
 *   reply    {"id": "...", "ok": true, "result": {...}} or {"id": "...", "ok": false, "error": "<code>"}
 */
sealed class BridgeCall {
    abstract val id: String

    /** `lock.state` → {locked, relockSeconds, choices} */
    data class LockState(override val id: String) : BridgeCall()

    /** `lock.setRelockSeconds` {seconds: 0|15|30|60} → {relockSeconds}. The lock itself cannot be turned off. */
    data class SetRelock(override val id: String, val seconds: Int) : BridgeCall()

    /** `auth.confirm` {reason} → {confirmed}. Fresh biometric/passcode check before a sensitive action. */
    data class ConfirmSensitive(override val id: String, val reason: String) : BridgeCall()

    /** `pair.scan` → {available}. Opens the native pairing screen; scanned codes never go to the page. */
    data class OpenScanner(override val id: String) : BridgeCall()

    /** `notifications.permission` → {granted} */
    data class NotificationPermission(override val id: String) : BridgeCall()

    /** `pair.remove` → {removed}. The phone removes itself after a fresh unlock; this deletes its keys. */
    data class RemovePairing(override val id: String) : BridgeCall()

    companion object {
        const val MAX_MESSAGE_CHARS = 4096
        const val MAX_REASON_CHARS = 120
        val RELOCK_SECONDS = setOf(0, 15, 30, 60)

        private val ID = Regex("^[A-Za-z0-9_-]{1,64}$")

        fun isValidId(id: String?): Boolean = id != null && ID.matches(id)

        fun parse(method: String?, id: String?, args: Map<String, Any?>): BridgeCall? {
            if (id == null || !isValidId(id)) return null
            return when (method) {
                "lock.state" -> if (args.isEmpty()) LockState(id) else null
                "lock.setRelockSeconds" -> {
                    if (args.keys != setOf("seconds")) return null
                    val seconds = integral(args["seconds"])?.takeIf { it in RELOCK_SECONDS.map(Int::toLong) } ?: return null
                    SetRelock(id, seconds.toInt())
                }
                "auth.confirm" -> {
                    if (args.keys != setOf("reason")) return null
                    val reason = (args["reason"] as? String)?.trim() ?: return null
                    if (reason.isEmpty() || reason.length > MAX_REASON_CHARS || reason.any { it.isISOControl() }) return null
                    ConfirmSensitive(id, reason)
                }
                "pair.scan" -> if (args.isEmpty()) OpenScanner(id) else null
                "notifications.permission" -> if (args.isEmpty()) NotificationPermission(id) else null
                "pair.remove" -> if (args.isEmpty()) RemovePairing(id) else null
                else -> null
            }
        }

        private fun integral(value: Any?): Long? = when (value) {
            is Int -> value.toLong()
            is Long -> value
            is Double -> if (value % 1.0 == 0.0 && value in -1e9..1e9) value.toLong() else null
            else -> null
        }
    }
}
