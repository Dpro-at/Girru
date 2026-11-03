package dev.girru.app.link

/**
 * A small JSON reader and writer for the computer's answers inside a session
 * (replies, run frames, approval full views), which can be nested. Protocol
 * envelopes and signed bodies stay on [dev.girru.app.crypto.FlatJson].
 *
 * Values: Map<String, Any?> (keys in order), List<Any?>, String, Long (whole
 * numbers that fit), Double, Boolean, null. Duplicate keys, trailing text and
 * nesting deeper than [MAX_DEPTH] are refused. No Android types, so it runs in
 * JVM tests.
 */
object Json {
    const val MAX_DEPTH = 64

    /** The value, or null when [text] is not valid JSON (use [readObject] to tell `null` apart). */
    fun parse(text: String): Any? = try {
        Reader(text).readDocument()
    } catch (e: IllegalArgumentException) {
        null
    }

    /** One JSON object, or null when the text is anything else. */
    @Suppress("UNCHECKED_CAST")
    fun readObject(text: String): Map<String, Any?>? = try {
        Reader(text).readDocument() as? Map<String, Any?>
    } catch (e: IllegalArgumentException) {
        null
    }

    /** Text for showing a value to the owner: two-space indent, keys in the order received. */
    fun pretty(value: Any?): String = StringBuilder().also { write(it, value, 0, pretty = true) }.toString()

    fun compact(value: Any?): String = StringBuilder().also { write(it, value, 0, pretty = false) }.toString()

    private fun write(sb: StringBuilder, value: Any?, level: Int, pretty: Boolean) {
        when (value) {
            null -> sb.append("null")
            is String -> appendString(sb, value)
            is Boolean -> sb.append(if (value) "true" else "false")
            is Int, is Long -> sb.append(value.toString())
            is Double -> sb.append(if (value.isFinite()) number(value) else "null")
            is Map<*, *> -> {
                if (value.isEmpty()) {
                    sb.append("{}")
                    return
                }
                sb.append('{')
                var first = true
                for ((k, v) in value) {
                    if (!first) sb.append(',')
                    first = false
                    newline(sb, level + 1, pretty)
                    appendString(sb, k.toString())
                    sb.append(if (pretty) ": " else ":")
                    write(sb, v, level + 1, pretty)
                }
                newline(sb, level, pretty)
                sb.append('}')
            }
            is List<*> -> {
                if (value.isEmpty()) {
                    sb.append("[]")
                    return
                }
                sb.append('[')
                value.forEachIndexed { i, v ->
                    if (i > 0) sb.append(',')
                    newline(sb, level + 1, pretty)
                    write(sb, v, level + 1, pretty)
                }
                newline(sb, level, pretty)
                sb.append(']')
            }
            else -> throw IllegalArgumentException("unsupported JSON value")
        }
    }

    private fun number(d: Double): String =
        if (d == Math.floor(d) && kotlin.math.abs(d) < 1e15) d.toLong().toString() else d.toString()

    private fun newline(sb: StringBuilder, level: Int, pretty: Boolean) {
        if (!pretty) return
        sb.append('\n')
        repeat(level) { sb.append("  ") }
    }

    private fun appendString(sb: StringBuilder, value: String) {
        sb.append('"')
        for (c in value) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (c < ' ' || c == '\u2028' || c == '\u2029') sb.append(String.format(java.util.Locale.ROOT, "\\u%04x", c.code)) else sb.append(c)
            }
        }
        sb.append('"')
    }

    private class Reader(private val s: String) {
        private var i = 0

        fun readDocument(): Any? {
            val v = readValue(0)
            skipSpace()
            require(i == s.length) { "trailing text" }
            return v
        }

        private fun readValue(depth: Int): Any? {
            require(depth <= MAX_DEPTH) { "too deep" }
            skipSpace()
            return when (peek()) {
                '{' -> readObject(depth)
                '[' -> readArray(depth)
                '"' -> readString()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> readNumber()
            }
        }

        private fun readObject(depth: Int): Map<String, Any?> {
            expect('{')
            val out = LinkedHashMap<String, Any?>()
            skipSpace()
            if (peek() == '}') {
                i++
                return out
            }
            while (true) {
                skipSpace()
                val key = readString()
                skipSpace()
                expect(':')
                require(!out.containsKey(key)) { "duplicate key" }
                out[key] = readValue(depth + 1)
                skipSpace()
                when (next()) {
                    ',' -> continue
                    '}' -> return out
                    else -> throw IllegalArgumentException("bad object")
                }
            }
        }

        private fun readArray(depth: Int): List<Any?> {
            expect('[')
            val out = ArrayList<Any?>()
            skipSpace()
            if (peek() == ']') {
                i++
                return out
            }
            while (true) {
                out += readValue(depth + 1)
                skipSpace()
                when (next()) {
                    ',' -> continue
                    ']' -> return out
                    else -> throw IllegalArgumentException("bad array")
                }
            }
        }

        private fun literal(word: String, value: Any?): Any? {
            require(s.startsWith(word, i)) { "bad literal" }
            i += word.length
            return value
        }

        private fun readNumber(): Any {
            val start = i
            if (i < s.length && s[i] == '-') i++
            val intStart = i
            while (i < s.length && s[i] in '0'..'9') i++
            require(i > intStart) { "bad number" }
            require(!(s[intStart] == '0' && i - intStart > 1)) { "leading zero" }
            var whole = true
            if (i < s.length && s[i] == '.') {
                whole = false
                i++
                val f = i
                while (i < s.length && s[i] in '0'..'9') i++
                require(i > f) { "bad fraction" }
            }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                whole = false
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                val e = i
                while (i < s.length && s[i] in '0'..'9') i++
                require(i > e) { "bad exponent" }
            }
            val text = s.substring(start, i)
            if (whole) text.toLongOrNull()?.let { return it }
            return text.toDoubleOrNull()?.takeIf { it.isFinite() } ?: throw IllegalArgumentException("bad number")
        }

        private fun readString(): String {
            expect('"')
            val sb = StringBuilder()
            while (true) {
                val c = next()
                when {
                    c == '"' -> return sb.toString()
                    c == '\\' -> when (val e = next()) {
                        '"', '\\', '/' -> sb.append(e)
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000C')
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'u' -> {
                            require(i + 4 <= s.length) { "bad escape" }
                            val hex = s.substring(i, i + 4)
                            require(hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) { "bad escape" }
                            sb.append(hex.toInt(16).toChar())
                            i += 4
                        }
                        else -> throw IllegalArgumentException("bad escape")
                    }
                    c < ' ' -> throw IllegalArgumentException("control character")
                    else -> sb.append(c)
                }
            }
        }

        private fun skipSpace() {
            while (i < s.length && s[i] in " \t\r\n") i++
        }

        private fun peek(): Char {
            require(i < s.length) { "unexpected end" }
            return s[i]
        }

        private fun next(): Char = peek().also { i++ }

        private fun expect(c: Char) {
            require(next() == c) { "expected $c" }
        }
    }
}
