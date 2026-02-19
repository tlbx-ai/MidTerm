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

    private static readonly HashSet<string> HopByHopHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
        "TE", "Trailer", "Transfer-Encoding", "Upgrade"
    };

    private static readonly HashSet<string> StrippedResponseHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Content-Security-Policy", "Content-Security-Policy-Report-Only",
        "X-Frame-Options", "Cross-Origin-Opener-Policy", "Cross-Origin-Embedder-Policy",
        "Cross-Origin-Resource-Policy"
    };

    private static readonly HashSet<string> ForwardedRequestHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Accept", "Accept-Encoding", "Accept-Language", "Authorization", "Cache-Control",
        "Content-Type", "Content-Length", "Cookie", "If-Match", "If-Modified-Since",
        "If-None-Match", "If-Unmodified-Since", "Range", "Referer", "User-Agent"
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
        if (!context.Request.Path.StartsWithSegments(ProxyPrefix, out var remaining))
        {
            await _next(context);
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
    }

    private async Task ProxyHttpAsync(HttpContext context, Uri targetUri, string path)
    {
        var currentUrl = BuildUpstreamUrl(targetUri, path, context.Request.QueryString.Value);

        // Follow redirects internally (up to 10 hops) so the iframe stays at /webpreview/
        const int maxRedirects = 10;
        HttpResponseMessage? upstreamResponse = null;

        for (var redirect = 0; redirect <= maxRedirects; redirect++)
        {
            var requestMessage = new HttpRequestMessage(
                redirect == 0 ? new HttpMethod(context.Request.Method) : HttpMethod.Get,
                currentUrl);

            // Forward request headers
            foreach (var header in context.Request.Headers)
            {
                if (HopByHopHeaders.Contains(header.Key))
                    continue;
                if (!ForwardedRequestHeaders.Contains(header.Key))
                    continue;

                requestMessage.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
            }

            // Add forwarded headers
            requestMessage.Headers.TryAddWithoutValidation("X-Forwarded-For",
                context.Connection.RemoteIpAddress?.ToString() ?? "127.0.0.1");
            requestMessage.Headers.TryAddWithoutValidation("X-Forwarded-Proto", "https");
            requestMessage.Headers.TryAddWithoutValidation("X-Forwarded-Host", context.Request.Host.ToString());

            // Forward request body only on the first (non-redirect) request
            if (redirect == 0 && (context.Request.ContentLength > 0 || context.Request.Headers.ContainsKey("Transfer-Encoding")))
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

            // Check if this is an HTML response that needs <base> injection
            var contentType = upstreamResponse.Content.Headers.ContentType?.MediaType;
            if (contentType is "text/html")
            {
                await ProxyHtmlResponseAsync(context, upstreamResponse);
            }
            else
            {
                // Stream non-HTML responses directly
                await using var stream = await upstreamResponse.Content.ReadAsStreamAsync(context.RequestAborted);
                await stream.CopyToAsync(context.Response.Body, context.RequestAborted);
            }
        }
    }

    private async Task ProxyHtmlResponseAsync(HttpContext context, HttpResponseMessage upstreamResponse)
    {
        // HTML needs modification (<base> injection), so we must decompress manually,
        // modify the HTML, then send uncompressed. Non-HTML responses flow through
        // compressed since AutomaticDecompression is None on the HttpClient.
        var contentEncoding = upstreamResponse.Content.Headers.ContentEncoding.FirstOrDefault();
        await using var rawStream = await upstreamResponse.Content.ReadAsStreamAsync(context.RequestAborted);

        Stream decompressed = contentEncoding?.ToLowerInvariant() switch
        {
            "gzip" => new GZipStream(rawStream, CompressionMode.Decompress),
            "br" => new BrotliStream(rawStream, CompressionMode.Decompress),
            "deflate" => new DeflateStream(rawStream, CompressionMode.Decompress),
            _ => rawStream
        };

        string html;
        await using (decompressed)
        {
            using var reader = new StreamReader(decompressed, Encoding.UTF8);
            html = await reader.ReadToEndAsync(context.RequestAborted);
        }

        // Inject <base href="/webpreview/"> after <head> or <head ...>
        html = HeadTagRegex().Replace(html, "$0<base href=\"/webpreview/\">", 1);

        // Send uncompressed — strip Content-Encoding and Content-Length for this response
        context.Response.Headers.Remove("Content-Length");
        context.Response.Headers.Remove("Content-Encoding");
        context.Response.ContentType = "text/html; charset=utf-8";
        await context.Response.WriteAsync(html, context.RequestAborted);
    }

    private async Task ProxyWebSocketAsync(HttpContext context, Uri targetUri, string path)
    {
        var upstreamUrl = BuildUpstreamWsUrl(targetUri, path, context.Request.QueryString.Value);

        using var upstream = new ClientWebSocket();
        _service.ConfigureWebSocket(upstream);

        // Forward cookies
        var cookies = context.Request.Headers.Cookie;
        if (cookies.Count > 0)
        {
            upstream.Options.SetRequestHeader("Cookie", string.Join("; ", cookies!));
        }

        try
        {
            await upstream.ConnectAsync(new Uri(upstreamUrl), context.RequestAborted);
        }
        catch (Exception)
        {
            context.Response.StatusCode = 502;
            return;
        }

        using var downstream = await context.WebSockets.AcceptWebSocketAsync();

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
}
