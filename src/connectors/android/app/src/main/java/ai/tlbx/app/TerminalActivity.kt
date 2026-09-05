package ai.tlbx.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Build
import android.view.View
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import java.net.URI

class TerminalActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var store: ServerStore
    private lateinit var server: Server
    private val handler = Handler(Looper.getMainLooper())
    private var backgroundedAt = 0L
    private var pageFailed = false
    private var predictiveBackCallback: Any? = null
    private val warmPage = object : Runnable {
        override fun run() {
            if (backgroundedAt > 0 && this@TerminalActivity::webView.isInitialized) {
                refreshPageConnection()
                handler.postDelayed(this, WARM_REFRESH_INTERVAL_MS)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = ServerStore(this)
        val serverId = intent.getStringExtra(EXTRA_SERVER_ID)
        server = serverId?.let(store::load) ?: run {
            finish()
            return
        }
        setContentView(R.layout.activity_terminal)

        findViewById<TextView>(R.id.instance_name).text = server.name
        findViewById<Button>(R.id.btn_settings).setOnClickListener { finish() }
        findViewById<Button>(R.id.btn_reload).setOnClickListener { webView.reload() }

        webView = findViewById(R.id.webview)
        configureWebView()
        registerPredictiveBack()
        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(server.url)
        }
    }

    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = false
            useWideViewPort = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            safeBrowsingEnabled = true
            userAgentString = "$userAgentString tlbx-app/1.0"
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, false)
        }
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                pageFailed = false
            }

            override fun onPageFinished(view: WebView, url: String?) {
                if (!pageFailed) store.markConnected(server.id)
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
                pageFailed = true
                Toast.makeText(this@TerminalActivity, R.string.certificate_rejected, Toast.LENGTH_LONG).show()
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val target = request.url
                if (sameOrigin(target.toString(), server.url)) return false
                return openExternally(target)
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                val parent = view.parent as? android.view.ViewGroup
                parent?.removeView(view)
                view.destroy()
                recreate()
                return true
            }
        }
    }

    private fun openExternally(uri: Uri): Boolean {
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
            true
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show()
            true
        }
    }

    private fun sameOrigin(candidate: String?, configured: String): Boolean = runCatching {
        val left = URI(candidate ?: return false)
        val right = URI(configured)
        left.scheme.equals(right.scheme, ignoreCase = true) &&
            left.host.equals(right.host, ignoreCase = true) &&
            effectivePort(left) == effectivePort(right)
    }.getOrDefault(false)

    private fun effectivePort(uri: URI): Int = when {
        uri.port >= 0 -> uri.port
        uri.scheme.equals("https", ignoreCase = true) -> 443
        else -> 80
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onStop() {
        backgroundedAt = System.currentTimeMillis()
        handler.removeCallbacks(warmPage)
        handler.postDelayed(warmPage, WARM_REFRESH_INTERVAL_MS)
        super.onStop()
    }

    override fun onStart() {
        super.onStart()
        if (backgroundedAt > 0) {
            handler.removeCallbacks(warmPage)
            refreshPageConnection()
            backgroundedAt = 0
        }
    }

    private fun refreshPageConnection() {
        if (pageFailed || webView.url.isNullOrBlank()) {
            webView.loadUrl(server.url)
            return
        }
        webView.evaluateJavascript(
            "window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));" +
                "fetch('/api/version',{cache:'no-store',credentials:'include'}).catch(()=>{});",
            null
        )
    }

    private fun handleBack() {
        if (webView.canGoBack()) webView.goBack() else finish()
    }

    private fun registerPredictiveBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val callback = android.window.OnBackInvokedCallback { handleBack() }
            predictiveBackCallback = callback
            onBackInvokedDispatcher.registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                callback
            )
        }
    }

    @SuppressLint("GestureBackNavigation")
    @Deprecated("Used as the compatibility path below Android 13")
    override fun onBackPressed() {
        handleBack()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            (predictiveBackCallback as? android.window.OnBackInvokedCallback)?.let {
                onBackInvokedDispatcher.unregisterOnBackInvokedCallback(it)
            }
        }
        if (!isChangingConfigurations) webView.destroy()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_SERVER_ID = "server_id"
        private const val WARM_REFRESH_INTERVAL_MS = 5 * 60 * 1000L
    }
}
