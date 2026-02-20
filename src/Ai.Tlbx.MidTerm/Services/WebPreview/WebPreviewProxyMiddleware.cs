using System.IO.Compression;
using System.Net.WebSockets;
using System.Text;
using System.Text.RegularExpressions;

namespace Ai.Tlbx.MidTerm.Services.WebPreview;

public sealed partial class WebPreviewProxyMiddleware
{
    private const string ProxyPrefix = "/webpreview";
    private const int WsBufferSize = 8192;
    private static readonly TimeSpan WsCloseTimeout = TimeSpan.FromSeconds(5);

    // Injected into proxied HTML to rewrite URLs in fetch/XHR/DOM at runtime.
    // Rewrites root-relative URLs to /webpreview/... and absolute external URLs
    // to /webpreview/_ext?u=... so all requests go through the MT proxy.
    // Patches: fetch, XHR, element .src/.href setters, setAttribute, window.open.
    private const string UrlRewriteScript = """
        <script>(function(){
          var P="/webpreview",E=P+"/_ext?u=";
          function r(u){
            if(typeof u!=="string")return u;
            if(u.startsWith("/")&&!u.startsWith(P+"/")&&!u.startsWith("//"))return P+u;
            if(u.startsWith("http://")|| u.startsWith("https://")){
              try{var h=new URL(u);
                if(h.host===location.host&&!h.pathname.startsWith(P+"/"))return P+h.pathname+h.search+h.hash;
                if(h.host!==location.host)return E+encodeURIComponent(u);
              }catch(e){}
            }
            return u;
          }
          var F=window.fetch;
          window.fetch=function(u,o){return F.call(this,typeof u==="string"?r(u):u,o);};
          var X=XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open=function(m,u){var a=[].slice.call(arguments);a[1]=r(u);return X.apply(this,a);};
          // Patch .src property on elements that load resources
          ["HTMLScriptElement","HTMLImageElement","HTMLIFrameElement","HTMLSourceElement","HTMLEmbedElement","HTMLVideoElement","HTMLAudioElement"].forEach(function(n){
            var p=window[n]&&window[n].prototype;if(!p)return;
            var d=Object.getOwnPropertyDescriptor(p,"src");if(!d||!d.set)return;
            Object.defineProperty(p,"src",{set:function(v){d.set.call(this,r(v));},get:d.get,configurable:true,enumerable:true});
          });
          // Patch .href on link elements (stylesheets, preloads)
          var ld=Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype,"href");
          if(ld&&ld.set){Object.defineProperty(HTMLLinkElement.prototype,"href",{set:function(v){ld.set.call(this,r(v));},get:ld.get,configurable:true,enumerable:true});}
          // Patch setAttribute for src/href/action/poster
          var sa=Element.prototype.setAttribute;
          Element.prototype.setAttribute=function(n,v){if(typeof v==="string"&&/^(src|href|action|poster)$/i.test(n))v=r(v);return sa.call(this,n,v);};
          // Patch window.open
          var wo=window.open;
          window.open=function(u){var a=[].slice.call(arguments);if(typeof u==="string")a[0]=r(u);return wo.apply(this,a);};
          // Patch Audio constructor (new Audio('/path/to/file.mp3'))
          var OA=window.Audio;
          if(OA){window.Audio=function(u){return new OA(r(u));};window.Audio.prototype=OA.prototype;}
          // Patch navigator.sendBeacon
          if(navigator.sendBeacon){var sb=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(u,d){return sb(r(u),d);};}
          // Patch Image constructor (new Image().src is handled by setter, but direct constructor arg)
          var OI=window.Image;
          if(OI){window.Image=function(w,h){var i=new OI(w,h);return i;};window.Image.prototype=OI.prototype;}
          // MutationObserver: catch elements added via innerHTML/insertAdjacentHTML/document.write
          new MutationObserver(function(muts){
            for(var i=0;i<muts.length;i++){
              var nodes=muts[i].addedNodes;
              for(var j=0;j<nodes.length;j++){
                var n=nodes[j];if(n.nodeType!==1)continue;
                var els=n.querySelectorAll?[n].concat([].slice.call(n.querySelectorAll("[src],[href]"))):[n];
                for(var k=0;k<els.length;k++){
                  var el=els[k];if(!el.getAttribute)continue;
                  var s=el.getAttribute("src");
                  if(s){var rs=r(s);if(rs!==s)sa.call(el,"src",rs);}
                  var h=el.getAttribute("href");
                  if(h){var rh=r(h);if(rh!==h)sa.call(el,"href",rh);}
                }
              }
            }
          }).observe(document.documentElement,{childList:true,subtree:true});
        })();</script>
        """;


    private static readonly HashSet<string> HopByHopHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
        "TE", "Trailer", "Transfer-Encoding", "Upgrade"
    };

    private static readonly HashSet<string> StrippedResponseHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Content-Security-Policy", "Content-Security-Policy-Report-Only",
        "X-Frame-Options", "Cross-Origin-Opener-Policy", "Cross-Origin-Embedder-Policy",
        "Cross-Origin-Resource-Policy",
        "Set-Cookie"  // Cookies managed by server-side cookie jar, not forwarded to browser
    };

    // Headers that must NOT be forwarded from browser to upstream.
    // Everything else is forwarded (blocklist approach for maximum compatibility).
    private static readonly HashSet<string> BlockedRequestHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        // Hop-by-hop (also in HopByHopHeaders, but listed for completeness)
        "Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
        "TE", "Trailer", "Transfer-Encoding", "Upgrade",
        // Host is set by HttpClient from the request URI
        "Host",
        // Browser cookies are MT session cookies — upstream cookies come from CookieContainer
        "Cookie",
        // WebSocket negotiation headers managed by ClientWebSocket
        "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Extensions",
        "Sec-WebSocket-Protocol",
        // Browser security headers that would confuse the upstream
        "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Sec-Fetch-User",
        // Content headers are set on HttpContent, not the request
        "Content-Type", "Content-Length"
    };

    private readonly RequestDelegate _next;
    private readonly WebPreviewService _service;

    public WebPreviewProxyMiddleware(RequestDelegate next, WebPreviewService service)
    {
        _next = next;
        _service = service;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path;

        if (path.StartsWithSegments(ProxyPrefix, out var remaining))
        {
            // External URL proxy: /webpreview/_ext?u=https%3A%2F%2Fexample.com%2Fscript.js
            var remainingPath = remaining.Value ?? "";
            if (remainingPath.StartsWith("/_ext", StringComparison.Ordinal))
            {
                await ProxyExternalAsync(context);
                return;
            }

            var targetUri = _service.TargetUri;
            if (targetUri is null)
            {
                context.Response.StatusCode = 502;
                context.Response.ContentType = "text/plain";
                await context.Response.WriteAsync("No web preview target configured.");
                return;
            }

            if (context.WebSockets.IsWebSocketRequest)
            {
                await ProxyWebSocketAsync(context, targetUri, remaining.Value ?? "/");
            }
            else
            {
                await ProxyHttpAsync(context, targetUri, remaining.Value ?? "/");
            }

            return;
        }

        // Catch-all: if web preview is active and this isn't a known MidTerm path,
        // it's likely a leaked root-relative URL from the proxied site (e.g. /s/player/...,
        // /youtubei/v1/...). Proxy it to the upstream target directly.
        if (_service.IsActive && !IsMidTermPath(path.Value ?? "/"))
        {
            var targetUri = _service.TargetUri!;
            var proxyPath = path.Value ?? "/";
            if (context.WebSockets.IsWebSocketRequest)
            {
                await ProxyWebSocketAsync(context, targetUri, proxyPath);
            }
            else
            {
                await ProxyHttpAsync(context, targetUri, proxyPath);
            }

            return;
        }

        await _next(context);
    }

    /// <summary>
    /// Returns true if the path belongs to MidTerm itself (API, WebSocket, static files).
    /// Paths that don't match are candidates for proxying to the web preview target.
    /// </summary>
    private static bool IsMidTermPath(string path)
    {
        // Known MidTerm path prefixes
        if (path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/ws/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/js/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/css/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/fonts/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/locales/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/img/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/favicon/", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        // Root-level MidTerm files
        return path is "/"
            or "/index.html"
            or "/login.html"
            or "/trust.html"
            or "/web-preview-popup.html"
            or "/favicon.ico"
            or "/site.webmanifest"
            or "/THIRD-PARTY-LICENSES.txt"
            or "/midFont-style.css";
    }

    private async Task ProxyHttpAsync(HttpContext context, Uri targetUri, string path)
    {
        var currentUrl = BuildUpstreamUrl(targetUri, path, context.Request.QueryString.Value);

        // Follow redirects internally (up to 10 hops) so the iframe stays at /webpreview/
        const int maxRedirects = 10;
        HttpResponseMessage? upstreamResponse = null;

        var originalMethod = new HttpMethod(context.Request.Method);
        var currentMethod = originalMethod;

        for (var redirect = 0; redirect <= maxRedirects; redirect++)
        {
            var requestMessage = new HttpRequestMessage(currentMethod, currentUrl);

            // Forward all request headers except blocked ones (blocklist approach)
            foreach (var header in context.Request.Headers)
            {
                if (BlockedRequestHeaders.Contains(header.Key))
                    continue;

                requestMessage.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
            }

            // Add forwarded headers
            requestMessage.Headers.TryAddWithoutValidation("X-Forwarded-For",
                context.Connection.RemoteIpAddress?.ToString() ?? "127.0.0.1");
            requestMessage.Headers.TryAddWithoutValidation("X-Forwarded-Proto", "https");
            requestMessage.Headers.TryAddWithoutValidation("X-Forwarded-Host", context.Request.Host.ToString());

            // Forward request body on initial request and 307/308 redirects (which preserve method)
            if (redirect == 0 && currentMethod != HttpMethod.Get
                && (context.Request.ContentLength > 0 || context.Request.Headers.ContainsKey("Transfer-Encoding")))
            {
                requestMessage.Content = new StreamContent(context.Request.Body);
                if (context.Request.ContentType is not null)
                {
                    requestMessage.Content.Headers.ContentType =
                        System.Net.Http.Headers.MediaTypeHeaderValue.Parse(context.Request.ContentType);
                }
            }

            try
            {
                upstreamResponse?.Dispose();
                upstreamResponse = await _service.HttpClient.SendAsync(
                    requestMessage, HttpCompletionOption.ResponseHeadersRead, context.RequestAborted);
            }
            catch (HttpRequestException)
            {
                requestMessage.Dispose();
                context.Response.StatusCode = 502;
                context.Response.ContentType = "text/plain";
                await context.Response.WriteAsync("Failed to connect to upstream server.");
                return;
            }
            catch (TaskCanceledException)
            {
                requestMessage.Dispose();
                context.Response.StatusCode = 504;
                context.Response.ContentType = "text/plain";
                await context.Response.WriteAsync("Upstream server timed out.");
                return;
            }

            // Follow redirects internally instead of passing to browser
            var statusCode = (int)upstreamResponse.StatusCode;
            if (statusCode is >= 301 and <= 308)
            {
                var location = upstreamResponse.Headers.Location?.ToString()
                    ?? upstreamResponse.Content.Headers.ContentLocation?.ToString();
                if (location is not null)
                {
                    // Resolve relative redirects against current URL
                    if (Uri.TryCreate(new Uri(currentUrl), location, out var resolved))
                    {
                        currentUrl = resolved.ToString();
                        // 307/308 preserve method; 301/302/303 switch to GET
                        currentMethod = statusCode is 307 or 308 ? originalMethod : HttpMethod.Get;
                        requestMessage.Dispose();
                        continue;
                    }
                }
            }

            // Not a redirect — break out and send response
            requestMessage.Dispose();
            break;
        }

        if (upstreamResponse is null)
        {
            context.Response.StatusCode = 502;
            return;
        }

        using (upstreamResponse)
        {
            context.Response.StatusCode = (int)upstreamResponse.StatusCode;

            // Copy response headers, stripping problematic ones
            foreach (var header in upstreamResponse.Headers)
            {
                if (HopByHopHeaders.Contains(header.Key) || StrippedResponseHeaders.Contains(header.Key))
                    continue;

                // Strip Location headers — we followed redirects internally
                if (header.Key.Equals("Location", StringComparison.OrdinalIgnoreCase))
                    continue;

                context.Response.Headers[header.Key] = header.Value.ToArray();
            }

            foreach (var header in upstreamResponse.Content.Headers)
            {
                if (StrippedResponseHeaders.Contains(header.Key))
                    continue;
                context.Response.Headers[header.Key] = header.Value.ToArray();
            }

            // Rewrite text responses that may contain root-relative URLs
            var contentType = upstreamResponse.Content.Headers.ContentType?.MediaType;
            if (contentType is "text/html")
            {
                await ProxyHtmlResponseAsync(context, upstreamResponse);
            }
            else if (contentType is "text/css")
            {
                await ProxyCssResponseAsync(context, upstreamResponse);
            }
            else
            {
                // Stream binary/other responses directly
                await using var stream = await upstreamResponse.Content.ReadAsStreamAsync(context.RequestAborted);
                await stream.CopyToAsync(context.Response.Body, context.RequestAborted);
            }
        }
    }

    private async Task ProxyHtmlResponseAsync(HttpContext context, HttpResponseMessage upstreamResponse)
    {
        var html = await DecompressTextAsync(upstreamResponse, context.RequestAborted);

        // Rewrite root-relative URLs to go through the proxy.
        // <base href> only handles truly relative URLs (foo/bar.js),
        // but root-relative URLs (/path/to/file) need explicit rewriting.
        html = RootRelativeAttrRegex().Replace(html, "$1/webpreview/");
        html = RootRelativeSrcsetRegex().Replace(html, "$1/webpreview/");
        html = RootRelativeCssUrlRegex().Replace(html, "url(/webpreview/");

        // Rewrite absolute external URLs (https://cdn.example.com/...) to go through _ext proxy.
        // This allows MT to fetch third-party resources server-side, bypassing CORS/ad blockers.
        var targetHost = _service.TargetUri?.Host;
        html = AbsoluteUrlAttrRegex().Replace(html, m => RewriteExternalUrl(m, targetHost));
        html = AbsoluteUrlCssRegex().Replace(html, m => RewriteExternalCssUrl(m, targetHost));

        // Inject <base href> for truly relative URLs, plus a script that patches
        // fetch/XHR to rewrite root-relative URLs at runtime (safer than regex on JS source).
        html = HeadTagRegex().Replace(html, "$0<base href=\"/webpreview/\">" + UrlRewriteScript, 1);

        // Send uncompressed — strip Content-Encoding and Content-Length for this response
        context.Response.Headers.Remove("Content-Length");
        context.Response.Headers.Remove("Content-Encoding");
        context.Response.ContentType = "text/html; charset=utf-8";
        await context.Response.WriteAsync(html, context.RequestAborted);
    }

    private async Task ProxyCssResponseAsync(HttpContext context, HttpResponseMessage upstreamResponse)
    {
        var css = await DecompressTextAsync(upstreamResponse, context.RequestAborted);

        // Rewrite url(/...) references in CSS to go through the proxy
        css = RootRelativeCssUrlRegex().Replace(css, "url(/webpreview/");

        // Rewrite absolute external url() references
        css = AbsoluteUrlCssRegex().Replace(css, m => RewriteExternalCssUrl(m, null));

        context.Response.Headers.Remove("Content-Length");
        context.Response.Headers.Remove("Content-Encoding");
        context.Response.ContentType = "text/css; charset=utf-8";
        await context.Response.WriteAsync(css, context.RequestAborted);
    }

    private async Task ProxyExternalAsync(HttpContext context)
    {
        var externalUrl = context.Request.Query["u"].FirstOrDefault();
        if (string.IsNullOrEmpty(externalUrl) || !Uri.TryCreate(externalUrl, UriKind.Absolute, out var extUri))
        {
            context.Response.StatusCode = 400;
            context.Response.ContentType = "text/plain";
            await context.Response.WriteAsync("Missing or invalid 'u' parameter.");
            return;
        }

        if (extUri.Scheme is not ("http" or "https"))
        {
            context.Response.StatusCode = 400;
            return;
        }

        using var requestMessage = new HttpRequestMessage(new HttpMethod(context.Request.Method), extUri);

        // Forward all headers except blocked ones
        foreach (var header in context.Request.Headers)
        {
            if (BlockedRequestHeaders.Contains(header.Key))
                continue;
            requestMessage.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
        }

        // Forward request body for POST/PUT/PATCH
        if (context.Request.ContentLength > 0 || context.Request.Headers.ContainsKey("Transfer-Encoding"))
        {
            requestMessage.Content = new StreamContent(context.Request.Body);
            if (context.Request.ContentType is not null)
            {
                requestMessage.Content.Headers.ContentType =
                    System.Net.Http.Headers.MediaTypeHeaderValue.Parse(context.Request.ContentType);
            }
        }

        HttpResponseMessage upstreamResponse;
        try
        {
            upstreamResponse = await _service.HttpClient.SendAsync(
                requestMessage, HttpCompletionOption.ResponseHeadersRead, context.RequestAborted);
        }
        catch (HttpRequestException)
        {
            context.Response.StatusCode = 502;
            return;
        }
        catch (TaskCanceledException)
        {
            context.Response.StatusCode = 504;
            return;
        }

        using (upstreamResponse)
        {
            context.Response.StatusCode = (int)upstreamResponse.StatusCode;

            foreach (var header in upstreamResponse.Headers)
            {
                if (HopByHopHeaders.Contains(header.Key) || StrippedResponseHeaders.Contains(header.Key))
                    continue;
                context.Response.Headers[header.Key] = header.Value.ToArray();
            }

            foreach (var header in upstreamResponse.Content.Headers)
            {
                if (StrippedResponseHeaders.Contains(header.Key))
                    continue;
                context.Response.Headers[header.Key] = header.Value.ToArray();
            }

            var contentType = upstreamResponse.Content.Headers.ContentType?.MediaType;
            if (contentType is "text/css")
            {
                // Rewrite url() in external CSS too
                await ProxyCssResponseAsync(context, upstreamResponse);
            }
            else
            {
                await using var stream = await upstreamResponse.Content.ReadAsStreamAsync(context.RequestAborted);
                await stream.CopyToAsync(context.Response.Body, context.RequestAborted);
            }
        }
    }

    private static async Task<string> DecompressTextAsync(
        HttpResponseMessage response, CancellationToken cancellationToken)
    {
        var contentEncoding = response.Content.Headers.ContentEncoding.FirstOrDefault();
        await using var rawStream = await response.Content.ReadAsStreamAsync(cancellationToken);

        Stream decompressed = contentEncoding?.ToLowerInvariant() switch
        {
            "gzip" => new GZipStream(rawStream, CompressionMode.Decompress),
            "br" => new BrotliStream(rawStream, CompressionMode.Decompress),
            "deflate" => new DeflateStream(rawStream, CompressionMode.Decompress),
            _ => rawStream
        };

        await using (decompressed)
        {
            using var reader = new StreamReader(decompressed, Encoding.UTF8);
            return await reader.ReadToEndAsync(cancellationToken);
        }
    }

    private async Task ProxyWebSocketAsync(HttpContext context, Uri targetUri, string path)
    {
        var upstreamUrl = BuildUpstreamWsUrl(targetUri, path, context.Request.QueryString.Value);
        var upstreamUri = new Uri(upstreamUrl);

        using var upstream = new ClientWebSocket();
        // Configure SSL + forward server-side cookie jar (for SignalR session correlation)
        _service.ConfigureWebSocket(upstream, upstreamUri);

        // Forward all request headers except blocked ones (same blocklist as HTTP)
        foreach (var header in context.Request.Headers)
        {
            if (BlockedRequestHeaders.Contains(header.Key))
                continue;
            // Skip WebSocket upgrade headers — ClientWebSocket manages these
            if (header.Key.StartsWith("Sec-WebSocket-", StringComparison.OrdinalIgnoreCase))
                continue;

            try
            {
                upstream.Options.SetRequestHeader(header.Key, header.Value.ToString());
            }
            catch (ArgumentException)
            {
                // Some headers can't be set on ClientWebSocket — skip silently
            }
        }

        // Forward WebSocket sub-protocols (critical for SignalR)
        var subProtocols = context.WebSockets.WebSocketRequestedProtocols;
        foreach (var protocol in subProtocols)
        {
            upstream.Options.AddSubProtocol(protocol);
        }

        try
        {
            await upstream.ConnectAsync(upstreamUri, context.RequestAborted);
        }
        catch (WebSocketException)
        {
            context.Response.StatusCode = 502;
            return;
        }
        catch (HttpRequestException)
        {
            context.Response.StatusCode = 502;
            return;
        }

        // Accept downstream with the negotiated sub-protocol from upstream
        var acceptProtocol = upstream.SubProtocol;
        using var downstream = acceptProtocol is not null
            ? await context.WebSockets.AcceptWebSocketAsync(acceptProtocol)
            : await context.WebSockets.AcceptWebSocketAsync();

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);

        var downToUp = PipeWebSocketAsync(downstream, upstream, cts);
        var upToDown = PipeWebSocketAsync(upstream, downstream, cts);

        await Task.WhenAny(downToUp, upToDown);
        await cts.CancelAsync();

        await CloseWebSocketSafe(downstream);
        await CloseWebSocketSafe(upstream);
    }

    private static async Task PipeWebSocketAsync(
        WebSocket source, WebSocket destination, CancellationTokenSource cts)
    {
        var buffer = new byte[WsBufferSize];
        try
        {
            while (source.State == WebSocketState.Open && !cts.Token.IsCancellationRequested)
            {
                var result = await source.ReceiveAsync(buffer, cts.Token);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    break;
                }

                await destination.SendAsync(
                    new ArraySegment<byte>(buffer, 0, result.Count),
                    result.MessageType,
                    result.EndOfMessage,
                    cts.Token);
            }
        }
        catch (OperationCanceledException)
        {
            // Expected on shutdown
        }
        catch (WebSocketException)
        {
            // Connection dropped
        }
    }

    private static async Task CloseWebSocketSafe(WebSocket ws)
    {
        try
        {
            if (ws.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                using var timeout = new CancellationTokenSource(WsCloseTimeout);
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, timeout.Token);
            }
        }
        catch
        {
            // Best effort
        }
    }

    private static string BuildUpstreamUrl(Uri target, string path, string? queryString)
    {
        var sb = new StringBuilder(256);
        sb.Append(target.Scheme).Append("://").Append(target.Authority);
        var targetPath = target.AbsolutePath.TrimEnd('/');
        sb.Append(targetPath);
        if (!string.IsNullOrEmpty(path))
        {
            sb.Append(path);
        }
        if (!string.IsNullOrEmpty(queryString))
        {
            sb.Append(queryString);
        }
        return sb.ToString();
    }

    private static string BuildUpstreamWsUrl(Uri target, string path, string? queryString)
    {
        var scheme = target.Scheme == "https" ? "wss" : "ws";
        var sb = new StringBuilder(256);
        sb.Append(scheme).Append("://").Append(target.Authority);
        var targetPath = target.AbsolutePath.TrimEnd('/');
        sb.Append(targetPath);
        if (!string.IsNullOrEmpty(path))
        {
            sb.Append(path);
        }
        if (!string.IsNullOrEmpty(queryString))
        {
            sb.Append(queryString);
        }
        return sb.ToString();
    }

    [GeneratedRegex(@"<head(\s[^>]*)?>", RegexOptions.IgnoreCase)]
    private static partial Regex HeadTagRegex();

    // Matches src="/...", href="/...", action="/...", poster="/..." with word boundaries
    // to avoid matching data-src, data-href, metadata, etc.
    // Requires at least one path character after / to avoid matching broken attributes like href="/".
    [GeneratedRegex(@"(\b(?:src|href|action|poster)\s*=\s*[""'])/(?![/""'\s>])", RegexOptions.IgnoreCase)]
    private static partial Regex RootRelativeAttrRegex();

    // Matches root-relative URLs in srcset attributes (e.g., srcset="/img/foo.png 2x")
    [GeneratedRegex(@"(\bsrcset\s*=\s*[""'](?:[^""']*,\s*)?)/(?![/""'\s>])", RegexOptions.IgnoreCase)]
    private static partial Regex RootRelativeSrcsetRegex();

    // Matches url(/...) in inline CSS (with optional quotes)
    [GeneratedRegex(@"url\(\s*[""']?/(?!/)", RegexOptions.IgnoreCase)]
    private static partial Regex RootRelativeCssUrlRegex();

    // Matches absolute http(s) URLs in HTML attributes: src="https://...", href="http://..."
    [GeneratedRegex(@"(\b(?:src|href|action|poster)\s*=\s*[""'])(https?://[^""'\s>]+)", RegexOptions.IgnoreCase)]
    private static partial Regex AbsoluteUrlAttrRegex();

    // Matches absolute http(s) URLs in CSS url(): url(https://...) or url("https://...")
    [GeneratedRegex(@"(url\(\s*[""']?)(https?://[^""')>\s]+)", RegexOptions.IgnoreCase)]
    private static partial Regex AbsoluteUrlCssRegex();

    /// <summary>
    /// Rewrite absolute external URL in an HTML attribute to go through the _ext proxy.
    /// URLs pointing to the target host are rewritten to /webpreview/ (same-origin proxy).
    /// URLs pointing to other hosts go through /webpreview/_ext?u=...
    /// </summary>
    private static string RewriteExternalUrl(Match match, string? targetHost)
    {
        var prefix = match.Groups[1].Value;  // e.g. src="
        var url = match.Groups[2].Value;     // e.g. https://cdn.example.com/script.js

        // Same-host URLs → /webpreview/path (already handled by root-relative rewriting,
        // but absolute same-host URLs need rewriting too)
        if (targetHost is not null && Uri.TryCreate(url, UriKind.Absolute, out var uri)
            && uri.Host.Equals(targetHost, StringComparison.OrdinalIgnoreCase))
        {
            return prefix + "/webpreview" + uri.PathAndQuery;
        }

        // External URLs → /webpreview/_ext?u=encodedUrl
        return prefix + "/webpreview/_ext?u=" + Uri.EscapeDataString(url);
    }

    private static string RewriteExternalCssUrl(Match match, string? targetHost)
    {
        var prefix = match.Groups[1].Value;  // e.g. url(
        var url = match.Groups[2].Value;     // e.g. https://fonts.googleapis.com/css

        if (targetHost is not null && Uri.TryCreate(url, UriKind.Absolute, out var uri)
            && uri.Host.Equals(targetHost, StringComparison.OrdinalIgnoreCase))
        {
            return prefix + "/webpreview" + uri.PathAndQuery;
        }

        return prefix + "/webpreview/_ext?u=" + Uri.EscapeDataString(url);
    }
}
