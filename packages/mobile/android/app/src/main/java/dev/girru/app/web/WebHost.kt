package dev.girru.app.web

import android.annotation.SuppressLint
import android.net.Uri
import android.net.http.SslError
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ServiceWorkerClientCompat
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.girru.app.BuildConfig
import dev.girru.app.link.ContentSource
import java.io.ByteArrayInputStream

/**
 * Shows the paired computer's core-ui and nothing else. Every request to
 * [origin] is answered from [content] (the end-to-end session), never from the
 * network; every main-frame navigation and every http(s) request elsewhere is
 * refused, and external links open in the browser. So JavaScript and the
 * bridge only ever run in our page. No file or content access, no mixed
 * content, Safe Browsing on, no permission grants, no pop-up windows, TLS
 * errors are never bypassed.
 */
class WebHost(
    private val webView: WebView,
    private val origin: WebOrigin,
    private val content: ContentSource,
    private val openExternal: (Uri) -> Unit,
    private val onRendererGone: () -> Unit,
) {
    private var bridge: NativeBridge? = null

    @SuppressLint("SetJavaScriptEnabled")
    fun start(bridge: NativeBridge) {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            // File-URL cross access is off by default since API 16 and moot with file access off.
            setGeolocationEnabled(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            safeBrowsingEnabled = true
            mediaPlaybackRequiresUserGesture = true
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_SHOULD_INTERCEPT_REQUEST)
        ) {
            // Service workers bypass the WebViewClient; give them the same rule.
            ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(object : ServiceWorkerClientCompat() {
                override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? = intercept(request)
            })
        }
        webView.webViewClient = Client()
        webView.webChromeClient = Chrome()
        // Installed before the first load so the page never runs without the origin rule in place.
        this.bridge = bridge.takeIf { it.install(webView) }
        // The page's requests with a body go to the session through the bridge; only on our origin.
        if (this.bridge != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, FETCH_SHIM, setOf(origin.rule()))
        }
        webView.loadUrl(origin.startUrl)
    }

    fun canGoBack() = webView.canGoBack()

    fun goBack() = webView.goBack()

    fun destroy() {
        bridge?.uninstall(webView)
        bridge = null
        webView.stopLoading()
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            if (origin.matches(url.toString())) return false
            val scheme = url.scheme?.lowercase()
            // Other schemes (intent:, tel:, …) are dropped, not handed to other apps.
            if (request.isForMainFrame && (scheme == "https" || scheme == "http")) openExternal(url)
            return true
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            intercept(request)

        @SuppressLint("WebViewClientOnReceivedSslError")
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // Returning true keeps the app alive; the activity rebuilds a fresh WebView.
            onRendererGone()
            return true
        }
    }

    /** Same rule for page and service-worker requests. Runs on a WebView background thread. */
    private fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val scheme = request.url.scheme?.lowercase()
        if (origin.matches(request.url.toString())) {
            // Never falls through to the network: no answer from the session means an error page.
            // Requests with a body come through the bridge (interception carries no body).
            val path = (request.url.encodedPath ?: "/") + (request.url.encodedQuery?.let { "?$it" } ?: "")
            val answer = (if (request.method == "GET") content.load(path) else null)
                ?: return blocked(503, "Unavailable")
            // WebResourceResponse refuses redirects and out-of-range codes.
            if (answer.status !in 100..599 || answer.status in 300..399) return blocked(502, "Bad answer")
            return WebResourceResponse(
                answer.mimeType, "utf-8", answer.status, answer.reason.ifBlank { "OK" }, NO_STORE,
                answer.stream ?: ByteArrayInputStream(answer.body),
            )
        }
        if (scheme == "http" || scheme == "https" || scheme == "ws" || scheme == "wss") return blocked(403, "Blocked")
        return null
    }

    private fun blocked(status: Int, reason: String) =
        WebResourceResponse("text/plain", "utf-8", status, reason, NO_STORE, ByteArrayInputStream(ByteArray(0)))

    private class Chrome : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) = request.deny()

        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) {
            callback?.invoke(origin, false, false)
        }

        // TODO(MOB-UI-01): attachments from the composer need a file chooser here.
        override fun onShowFileChooser(
            webView: WebView?,
            filePathCallback: ValueCallback<Array<Uri>>?,
            fileChooserParams: FileChooserParams?,
        ): Boolean = false
    }

    private companion object {
        val NO_STORE = mapOf("Cache-Control" to "no-store")

        /**
         * Same-origin `/api/` requests other than GET become a bridge call
         * (`api.call`); the answer comes back as a normal Response. Also sets
         * `window.girruShell` so the page knows it runs in the app.
         */
        val FETCH_SHIM = """
            (() => {
              window.girruShell = Object.freeze({ platform: 'android', bridge: 1 });
              const bridge = window.girruNative, plain = window.fetch.bind(window), waiting = new Map();
              if (!bridge) return;
              bridge.addEventListener('message', e => {
                let m; try { m = JSON.parse(e.data); } catch { return; }
                const w = m && waiting.get(m.id); if (!w) return; waiting.delete(m.id);
                if (!m.ok) return w.reject(new TypeError('Failed to fetch'));
                const r = m.result || {};
                w.resolve(new Response(r.status === 204 ? null : r.body, { status: r.status, headers: { 'Content-Type': r.type || 'application/json' } }));
              });
              window.fetch = (input, init = {}) => {
                const req = new Request(input, init), url = new URL(req.url);
                if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || req.method === 'GET') return plain(input, init);
                return req.text().then(body => new Promise((resolve, reject) => {
                  const id = 'f' + crypto.getRandomValues(new Uint32Array(2)).join('');
                  waiting.set(id, { resolve, reject });
                  init.signal?.addEventListener('abort', () => { if (waiting.delete(id)) reject(new DOMException('Aborted', 'AbortError')); });
                  bridge.postMessage(JSON.stringify({ id, method: 'api.call', args: { method: req.method, path: url.pathname + url.search, body } }));
                }));
              };
            })();
        """.trimIndent()
    }
}
