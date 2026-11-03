package dev.girru.app.crypto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FlatJsonTest {
    @Test
    fun writesAndReadsBack() {
        val text = FlatJson.write("s" to "a\"b\\c\nd", "n" to 42L, "i" to 7, "b" to true)
        val read = FlatJson.read(text)!!
        assertEquals("a\"b\\c\nd", read["s"])
        assertEquals(42L, read["n"])
        assertEquals(7L, read["i"])
        assertEquals(true, read["b"])
    }

    @Test
    fun readsNullAndEscapes() {
        val read = FlatJson.read(""" { "a" : null , "u": "é\/" } """)!!
        assertEquals(null, read["a"])
        assertEquals("é/", read["u"])
    }

    @Test
    fun refusesNestedDuplicateFractionAndTrailing() {
        assertNull(FlatJson.read("""{"a":{"b":1}}"""))
        assertNull(FlatJson.read("""{"a":[1]}"""))
        assertNull(FlatJson.read("""{"a":1,"a":2}"""))
        assertNull(FlatJson.read("""{"a":1.5}"""))
        assertNull(FlatJson.read("""{"a":1} x"""))
        assertNull(FlatJson.read("""{"a":"x"""))
        assertNull(FlatJson.read("[]"))
    }
}
