package dev.girru.app.crypto

/**
 * Writes and reads flat JSON objects (string, integer and boolean values only).
 * The protocol payloads are flat, and keeping this free of Android's org.json
 * lets the protocol code run in plain JVM tests. Anything nested is refused.
 */
object FlatJson {
    fun write(vararg fields: Pair<String, Any>): String = buildString {
        append('{')
        fields.forEachIndexed { index, (key, value) ->
            if (index > 0) append(',')
            appendString(key)
            append(':')
            when (value) {
                is String -> appendString(value)
                is Int, is Long -> append(value.toString())
                is Boolean -> append(if (value) "true" else "false")
                else -> throw IllegalArgumentException("unsupported JSON value")
            }
        }
        append('}')
    }

    /** Returns the fields, or null when the text is not one flat object. Duplicate keys are refused. */
    fun read(text: String): Map<String, Any?>? = try {
        Reader(text).readObject()
    } catch (e: IllegalArgumentException) {
        null
    }

    private fun StringBuilder.appendString(value: String) {
        append('"')
        for (c in value) {
            when (c) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (c < ' ') append(String.format("\\u%04x", c.code)) else append(c)
            }
        }
        append('"')
    }

    private class Reader(private val s: String) {
        private var i = 0

        fun readObject(): Map<String, Any?> {
            val out = LinkedHashMap<String, Any?>()
            skipSpace()
            expect('{')
            skipSpace()
            if (peek() == '}') {
                i++
                return end(out)
            }
            while (true) {
                skipSpace()
                val key = readString()
                skipSpace()
                expect(':')
                skipSpace()
                require(!out.containsKey(key)) { "duplicate key" }
                out[key] = readValue()
                skipSpace()
                when (next()) {
                    ',' -> continue
                    '}' -> return end(out)
                    else -> throw IllegalArgumentException("bad object")
                }
            }
        }

        private fun end(out: Map<String, Any?>): Map<String, Any?> {
            skipSpace()
            require(i == s.length) { "trailing text" }
            return out
        }

        private fun readValue(): Any? = when (peek()) {
            '"' -> readString()
            't' -> literal("true", true)
            'f' -> literal("false", false)
            'n' -> literal("null", null)
            else -> readInteger()
        }

        private fun literal(word: String, value: Any?): Any? {
            require(s.startsWith(word, i)) { "bad literal" }
            i += word.length
            return value
        }

        private fun readInteger(): Long {
            val start = i
            if (peek() == '-') i++
            while (i < s.length && s[i] in '0'..'9') i++
            val digits = s.substring(start, i)
            require(digits.isNotEmpty() && digits != "-") { "bad number" }
            // Fractions and exponents are not used by the protocol.
            require(i == s.length || s[i] !in ".eE") { "not an integer" }
            return digits.toLongOrNull() ?: throw IllegalArgumentException("number too large")
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
                            val code = s.substring(i, i + 4).toIntOrNull(16)
                                ?: throw IllegalArgumentException("bad escape")
                            sb.append(code.toChar())
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
