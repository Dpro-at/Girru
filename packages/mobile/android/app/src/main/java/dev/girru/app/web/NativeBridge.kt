package dev.girru.app.web

import android.net.Uri
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * The page ↔ app bridge. It uses WebViewCompat.addWebMessageListener rather
 * than addJavascriptInterface: the platform then injects `window.girruNative`
 * only into pages from the paired origin, and every message says which origin
 * and frame sent it. Only main-frame messages from [origin] are handled, and
 * only the calls in [BridgeCall]. While the app is locked, only `lock.state` is answered.
 */
class NativeBridge(private val origin: WebOrigin, private val handler: Handler) {
    interface Handler {
        fun isLocked(): Boolean
        fun relockSeconds(): Int
        fun setRelockSeconds(seconds: Int): Int
        fun confirmSensitive(reason: String, done: (Boolean) -> Unit)
        /** Returns false when no scanner is available on this build. */
        fun openScanner(): Boolean
        fun requestNotificationPermission(done: (Boolean) -> Unit)
        fun removePairing(done: (Boolean) -> Unit)
        /** One chat page request with a body; [done] gets {status, type, body text}. */
        fun apiCall(method: String, path: String, body: String, done: (Int, String, String) -> Unit)
    }

    fun install(webView: WebView): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
        WebViewCompat.addWebMessageListener(webView, NAME, setOf(origin.rule()), listener)
        return true
    }

    fun uninstall(webView: WebView) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.removeWebMessageListener(webView, NAME)
        }
    }

    // Called on the UI thread.
    private val listener = WebViewCompat.WebMessageListener { _, message, sourceOrigin, isMainFrame, reply ->
        onMessage(message, sourceOrigin, isMainFrame, reply)
    }

    private fun onMessage(message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, reply: JavaScriptReplyProxy) {
        if (!isMainFrame || !origin.matches(sourceOrigin.toString())) return
        val text = message.data ?: return
        if (text.length > BridgeCall.MAX_API_MESSAGE_CHARS) return
        val obj = try {
            JSONObject(text)
        } catch (e: JSONException) {
            return
        }
        val id = obj.opt("id") as? String
        val args = HashMap<String, Any?>()
        val argsObj = obj.opt("args")
        when (argsObj) {
            null, JSONObject.NULL -> Unit
            is JSONObject -> argsObj.keys().forEach { key -> args[key] = argsObj.opt(key) }
            else -> return fail(reply, id, "bad_request")
        }
        val call = BridgeCall.parse(obj.opt("method") as? String, id, args) ?: return fail(reply, id, "bad_request")
        // Only a page request may be large; every other call stays small.
        if (call !is BridgeCall.ApiCall && text.length > BridgeCall.MAX_MESSAGE_CHARS) return fail(reply, call.id, "bad_request")
        val locked = handler.isLocked()
        // While locked only the lock state is answered; everything else is refused.
        if (locked && call !is BridgeCall.LockState) return fail(reply, call.id, "locked")
        when (call) {
            is BridgeCall.LockState -> ok(
                reply, call.id,
                JSONObject()
                    .put("locked", locked)
                    .put("relockSeconds", handler.relockSeconds())
                    .put("choices", JSONArray(BridgeCall.RELOCK_SECONDS.sorted())),
            )
            is BridgeCall.SetRelock -> ok(reply, call.id, JSONObject().put("relockSeconds", handler.setRelockSeconds(call.seconds)))
            is BridgeCall.ConfirmSensitive -> handler.confirmSensitive(call.reason) { confirmed ->
                ok(reply, call.id, JSONObject().put("confirmed", confirmed))
            }
            is BridgeCall.OpenScanner -> ok(reply, call.id, JSONObject().put("available", handler.openScanner()))
            is BridgeCall.NotificationPermission -> handler.requestNotificationPermission { granted ->
                ok(reply, call.id, JSONObject().put("granted", granted))
            }
            is BridgeCall.RemovePairing -> handler.removePairing { removed ->
                ok(reply, call.id, JSONObject().put("removed", removed))
            }
            is BridgeCall.ApiCall -> handler.apiCall(call.method, call.path, call.body) { status, type, body ->
                ok(reply, call.id, JSONObject().put("status", status).put("type", type).put("body", body))
            }
        }
    }

    private fun ok(reply: JavaScriptReplyProxy, id: String, result: JSONObject) {
        reply.postMessage(JSONObject().put("id", id).put("ok", true).put("result", result).toString())
    }

    private fun fail(reply: JavaScriptReplyProxy, id: String?, code: String) {
        // Without a valid id the page could not match the answer, so none is sent.
        if (!BridgeCall.isValidId(id)) return
        reply.postMessage(JSONObject().put("id", id).put("ok", false).put("error", code).toString())
    }

    companion object {
        /** The page sees `window.girruNative`. */
        const val NAME = "girruNative"
    }
}
