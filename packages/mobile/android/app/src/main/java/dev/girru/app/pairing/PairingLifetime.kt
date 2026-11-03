package dev.girru.app.pairing

/**
 * Scan once, stay paired (PROTOCOL.md "Pairing lifetime"). The owner picks how
 * long a pairing lasts without use; it counts from the last authenticated use
 * and every use renews it. The computer is the authority and may still refuse
 * the phone; this local copy only decides when to show the pairing screen
 * again without asking the computer first.
 */
enum class PairingLifetime(val days: Int?) {
    DAYS_30(30),
    DAYS_60(60),
    DAYS_90(90),
    DAYS_120(120),
    NEVER(null);

    /** Stored and sent as the number of days, or "never". */
    val wire: String get() = days?.toString() ?: "never"

    companion object {
        /** Same default as the computer's verifier. */
        val DEFAULT = DAYS_90

        fun fromWire(text: String?): PairingLifetime? = entries.firstOrNull { it.wire == text }
    }
}

object PairingExpiry {
    const val DAY_MS = 24 * 60 * 60 * 1000L

    /** Same rule as the computer: expired when more than `days` have passed since the last use. */
    fun isExpired(lifetime: PairingLifetime, lastUsedMs: Long, nowMs: Long): Boolean {
        val days = lifetime.days ?: return false
        // A clock set back is not treated as expiry; the computer decides with its own clock.
        if (nowMs < lastUsedMs) return false
        return nowMs - lastUsedMs > days * DAY_MS
    }

    /** The new last-use time after an authenticated use; it never moves backwards. */
    fun renew(lastUsedMs: Long, nowMs: Long): Long = maxOf(lastUsedMs, nowMs)

    /** When the pairing runs out if unused from now on, or null for never. */
    fun expiresAt(lifetime: PairingLifetime, lastUsedMs: Long): Long? =
        lifetime.days?.let { lastUsedMs + it * DAY_MS }
}
