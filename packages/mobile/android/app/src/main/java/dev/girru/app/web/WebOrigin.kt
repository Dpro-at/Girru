package dev.girru.app.web

import java.net.URI
import java.net.URISyntaxException

/**
 * The single origin the web host shows and runs JavaScript from. https only.
 * core-ui is served under [COMPUTER], a name that never resolves (`.invalid`
 * is reserved): every request to it is answered by the app from the
 * end-to-end session, so nothing of the page or its bridge travels over the
 * network in clear.
 */
class WebOrigin private constructor(
    val host: String,
    val port: Int,
    val startUrl: String,
) {
    val scheme: String get() = "https"

    /** Origin rule for WebViewCompat.addWebMessageListener. */
    fun rule(): String = "https://$host" + if (port == 443) "" else ":$port"

    fun matches(url: String?): Boolean {
        val uri = parseUri(url) ?: return false
        if (uri.scheme?.lowercase() != "https") return false
        val h = uri.host?.lowercase() ?: return false
        return h == host && (if (uri.port == -1) 443 else uri.port) == port
    }

    companion object {
        /** Where the paired computer's core-ui appears inside the app. */
        val COMPUTER: WebOrigin = parse("https://computer.girru.invalid/")!!

        fun parse(url: String?): WebOrigin? {
            val uri = parseUri(url) ?: return null
            if (uri.scheme?.lowercase() != "https" || uri.rawUserInfo != null) return null
            val host = uri.host?.lowercase() ?: return null
            val port = if (uri.port == -1) 443 else uri.port
            if (port !in 1..65535) return null
            return WebOrigin(host, port, uri.toString())
        }

        private fun parseUri(url: String?): URI? {
            if (url.isNullOrBlank()) return null
            return try {
                URI(url)
            } catch (e: URISyntaxException) {
                null
            }
        }
    }
}
