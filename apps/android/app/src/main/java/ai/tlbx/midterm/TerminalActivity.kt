package ai.tlbx.midterm

import android.app.Activity
import android.app.AlertDialog
import android.net.http.SslError
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.URL
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

class TerminalActivity : Activity() {

    private lateinit var webView: WebView
    private var serverUrl = ""
    private var password = ""
    private var serverId = ""
    private var expectedFingerprint = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_terminal)

        serverUrl = intent.getStringExtra("url") ?: ""
        password = intent.getStringExtra("password") ?: ""
        serverId = intent.getStringExtra("serverId") ?: ""
        expectedFingerprint = intent.getStringExtra("certFingerprint") ?: ""

        webView = findViewById(R.id.webview)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
        }

        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                val cert = error.certificate
                val fingerprint = cert?.toString() ?: "unknown"

                if (expectedFingerprint.isNotEmpty() && fingerprint == expectedFingerprint) {
                    handler.proceed()
                    return
                }

                runOnUiThread {
                    AlertDialog.Builder(this@TerminalActivity)
                        .setTitle("Certificate Trust")
                        .setMessage("This server uses a self-signed certificate.\n\nHost: ${error.url}\n\nTrust this certificate?")
                        .setPositiveButton("Trust") { _, _ ->
                            saveCertFingerprint(fingerprint)
                            handler.proceed()
                        }
                        .setNegativeButton("Cancel") { _, _ ->
                            handler.cancel()
                            finish()
                        }
                        .setCancelable(false)
                        .show()
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url.startsWith(serverUrl)) return false
                val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, request.url)
                startActivity(intent)
                return true
            }
        }

        if (password.isNotEmpty()) {
            autoLogin()
        } else {
            webView.loadUrl(serverUrl)
        }
    }

    private fun autoLogin() {
        Thread {
            try {
                val trustAll = createTrustAllManager()
                val sslContext = SSLContext.getInstance("TLS")
                sslContext.init(null, arrayOf(trustAll), null)

                val loginUrl = URL("$serverUrl/api/auth/login")
                val conn = loginUrl.openConnection() as HttpsURLConnection
                conn.sslSocketFactory = sslContext.socketFactory
                conn.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.doOutput = true

                OutputStreamWriter(conn.outputStream).use {
                    it.write("""{"password":"${password.replace("\"", "\\\"")}"}""")
                }

                val response = conn.responseCode
                if (response == 200) {
                    val cookies = conn.headerFields["Set-Cookie"]
                    cookies?.forEach { cookie ->
                        CookieManager.getInstance().setCookie(serverUrl, cookie)
                    }
                    CookieManager.getInstance().flush()
                }
                conn.disconnect()
            } catch (_: Exception) {
                // Auto-login failed — WebView will show login page
            }
            runOnUiThread { webView.loadUrl(serverUrl) }
        }.start()
    }

    private fun saveCertFingerprint(fingerprint: String) {
        val store = ServerStore(this)
        val servers = store.load()
        servers.find { it.id == serverId }?.let {
            it.certFingerprint = fingerprint
            store.save(servers)
        }
    }

    private fun createTrustAllManager() = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
