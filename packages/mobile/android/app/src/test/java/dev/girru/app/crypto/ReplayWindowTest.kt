package dev.girru.app.crypto

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReplayWindowTest {
    @Test
    fun acceptsEachCounterOnceInAnyOrderInsideTheWindow() {
        val w = ReplayWindow()
        assertTrue(w.accept(10))
        assertTrue(w.accept(8))
        assertFalse(w.accept(8))
        assertFalse(w.accept(10))
        assertTrue(w.accept(11))
        assertTrue(w.accept(9))
        assertFalse(w.accept(0))
        assertFalse(w.accept(-1))
    }

    @Test
    fun refusesCountersBelowTheWindow() {
        val w = ReplayWindow()
        assertTrue(w.accept(100))
        assertTrue(w.accept(100 - 63))
        assertFalse(w.accept(100 - 64))
        assertTrue(w.accept(1000))
        assertFalse(w.accept(100))
    }

    @Test
    fun survivesRestore() {
        val w = ReplayWindow()
        w.accept(5)
        w.accept(3)
        val again = ReplayWindow()
        again.restore(w.highest, w.seenBits)
        assertFalse(again.accept(5))
        assertFalse(again.accept(3))
        assertTrue(again.accept(4))
    }
}
