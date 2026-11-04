package dev.girru.app.crypto

/**
 * Sliding replay window of 64 for notices (PROTOCOL.md "Notice format"):
 * push services may deliver late or out of order, so a counter is accepted
 * once if it is above, or among the 64 below, the highest one seen. Call
 * [accept] only after every other check passed, so a forged notice changes no
 * state. State is two longs so it survives process restarts.
 * Session envelopes keep the stricter "above the last one" rule (G1Session).
 */
class ReplayWindow {
    var highest: Long = 0
        private set
    var seenBits: Long = 0
        private set

    fun restore(highest: Long, seenBits: Long) {
        this.highest = maxOf(0L, highest)
        this.seenBits = if (this.highest == 0L) 0L else seenBits
    }

    fun accept(counter: Long): Boolean {
        if (counter <= 0) return false
        if (counter > highest) {
            val shift = counter - highest
            seenBits = if (shift >= WINDOW) 0L else seenBits shl shift.toInt()
            seenBits = seenBits or 1L
            highest = counter
            return true
        }
        val offset = highest - counter
        if (offset >= WINDOW) return false
        val mask = 1L shl offset.toInt()
        if ((seenBits and mask) != 0L) return false
        seenBits = seenBits or mask
        return true
    }

    companion object {
        const val WINDOW = 64
    }
}
