import SwiftUI
import WebKit

struct TerminalView: View {
    let server: Server
    @ObservedObject var store: ServerStore
    @Environment(\.dismiss) private var dismiss
    @State private var showCertAlert = false
    @State private var pendingFingerprint = ""

    var body: some View {
        WebViewContainer(
            url: server.url,
            password: server.password,
            expectedFingerprint: server.certFingerprint,
            onCertChallenge: { fingerprint in
                pendingFingerprint = fingerprint
                showCertAlert = true
            },
            onCertAccepted: { fingerprint in
                store.updateFingerprint(serverId: server.id, fingerprint: fingerprint)
            }
        )
        .ignoresSafeArea()
        .overlay(alignment: .topLeading) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left.circle.fill")
                    .font(.title)
                    .foregroundStyle(.white.opacity(0.7))
                    .padding(12)
            }
        }
        .alert("Certificate Trust", isPresented: $showCertAlert) {
            Button("Trust") {
                store.updateFingerprint(serverId: server.id, fingerprint: pendingFingerprint)
            }
            Button("Cancel", role: .cancel) { dismiss() }
        } message: {
            Text("This server uses a self-signed certificate.\n\nFingerprint:\n\(pendingFingerprint.prefix(40))...\n\nTrust this certificate?")
        }
    }
}

struct WebViewContainer: UIViewRepresentable {
    let url: String
    let password: String
    let expectedFingerprint: String
    let onCertChallenge: (String) -> Void
    let onCertAccepted: (String) -> Void

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never

        if password.isEmpty {
            if let serverUrl = URL(string: url) {
                webView.load(URLRequest(url: serverUrl))
            }
        } else {
            context.coordinator.performAutoLogin(webView: webView)
        }
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        let parent: WebViewContainer

        init(parent: WebViewContainer) {
            self.parent = parent
        }

        func performAutoLogin(webView: WKWebView) {
            Task {
                let cookies = await CertificateTrust.performLogin(
                    url: parent.url, password: parent.password
                )
                await MainActor.run {
                    let cookieStore = webView.configuration.websiteDataStore.httpCookieStore
                    for cookie in cookies {
                        cookieStore.setCookie(cookie)
                    }
                    if let serverUrl = URL(string: parent.url) {
                        webView.load(URLRequest(url: serverUrl))
                    }
                }
            }
        }

        func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                      completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
                  let trust = challenge.protectionSpace.serverTrust else {
                completionHandler(.performDefaultHandling, nil)
                return
            }

            let fingerprint = CertificateTrust.fingerprint(of: trust) ?? "unknown"

            if !parent.expectedFingerprint.isEmpty && fingerprint == parent.expectedFingerprint {
                completionHandler(.useCredential, URLCredential(trust: trust))
                return
            }

            if parent.expectedFingerprint.isEmpty {
                parent.onCertAccepted(fingerprint)
                completionHandler(.useCredential, URLCredential(trust: trust))
                return
            }

            parent.onCertChallenge(fingerprint)
            completionHandler(.useCredential, URLCredential(trust: trust))
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                      decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let targetUrl = navigationAction.request.url,
               navigationAction.navigationType == .linkActivated,
               !targetUrl.absoluteString.hasPrefix(parent.url) {
                UIApplication.shared.open(targetUrl)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}
