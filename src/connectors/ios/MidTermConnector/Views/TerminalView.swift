import SwiftUI
import UIKit
import WebKit

struct TerminalView: View {
    let server: Server
    let showSettings: () -> Void
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model: WebViewModel

    init(server: Server, showSettings: @escaping () -> Void) {
        self.server = server
        self.showSettings = showSettings
        _model = StateObject(wrappedValue: WebViewModel(server: server))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { showSettings() } label: {
                    Label("Instances", systemImage: "shippingbox")
                }
                Spacer()
                Text(server.name)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                Button { model.reload() } label: {
                    Label("Reload", systemImage: "arrow.clockwise")
                        .labelStyle(.iconOnly)
                }
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(.bar)

            WebViewContainer(webView: model.webView)
                .ignoresSafeArea(edges: .bottom)
        }
        .onChange(of: scenePhase) { phase in
            switch phase {
            case .active: model.resume()
            case .background:
                model.enterBackground()
                BackgroundRefresh.schedule()
            default: break
            }
        }
    }
}

struct WebViewContainer: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

final class WebViewModel: NSObject, ObservableObject, WKNavigationDelegate {
    let webView: WKWebView
    private let server: Server
    private let configuredOrigin: URLComponents?
    private var pageFailed = false

    init(server: Server) {
        self.server = server
        configuredOrigin = URLComponents(string: server.url)
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.applicationNameForUserAgent = "tlbx-app/1.0"
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        loadConfiguredURL()
    }

    func reload() { webView.reload() }

    func enterBackground() {
        keepConnectionWarm()
    }

    func resume() {
        if webView.url == nil || pageFailed {
            loadConfiguredURL()
        } else {
            keepConnectionWarm()
        }
    }

    private func keepConnectionWarm() {
        webView.evaluateJavaScript(
            "window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));" +
            "fetch('/api/version',{cache:'no-store',credentials:'include'}).catch(()=>{});"
        )
    }

    private func loadConfiguredURL() {
        guard let url = URL(string: server.url) else { return }
        webView.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30))
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        pageFailed = false
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageFailed = false
        let store = ServerStore()
        store.markConnected(server.id)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        pageFailed = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        pageFailed = true
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let targetURL = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if sameOrigin(targetURL) {
            decisionHandler(.allow)
        } else if navigationAction.navigationType == .linkActivated {
            UIApplication.shared.open(targetURL)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.cancel)
        }
    }

    private func sameOrigin(_ url: URL) -> Bool {
        guard let target = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let configuredOrigin else { return false }
        return target.scheme?.caseInsensitiveCompare(configuredOrigin.scheme ?? "") == .orderedSame
            && target.host?.caseInsensitiveCompare(configuredOrigin.host ?? "") == .orderedSame
            && effectivePort(target) == effectivePort(configuredOrigin)
    }

    private func effectivePort(_ components: URLComponents) -> Int {
        components.port ?? (components.scheme?.lowercased() == "https" ? 443 : 80)
    }
}
