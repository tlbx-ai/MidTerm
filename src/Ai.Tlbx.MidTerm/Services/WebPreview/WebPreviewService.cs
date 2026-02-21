using System.Net;
using System.Net.Security;
using System.Net.WebSockets;
using System.Security.Cryptography.X509Certificates;
using Ai.Tlbx.MidTerm.Models.WebPreview;

namespace Ai.Tlbx.MidTerm.Services.WebPreview;

public sealed class WebPreviewService
{
    private volatile string? _targetUrl;
    private volatile Uri? _targetUri;
    private readonly int _serverPort;

    private HttpClient _httpClient;
    private CookieContainer _cookieContainer;
    private readonly object _clientLock = new();

    public string? TargetUrl => _targetUrl;
    public Uri? TargetUri => _targetUri;
    public bool IsActive => _targetUri is not null;

    public WebPreviewService(int serverPort)
    {
        _serverPort = serverPort;
        _cookieContainer = new CookieContainer();
        _httpClient = CreateHttpClient(_cookieContainer);
    }

    public HttpClient HttpClient => _httpClient;

    public bool SetTarget(string url)
    {
        if (string.IsNullOrWhiteSpace(url))
            return false;

        url = NormalizeUrl(url);

        if (!Uri.TryCreate(url.TrimEnd('/'), UriKind.Absolute, out var uri))
            return false;

        if (uri.Scheme is not ("http" or "https"))
            return false;

        // Prevent self-proxying
        if (IsLocalAddress(uri.Host) && uri.Port == _serverPort)
            return false;

        // Reset cookie jar when target changes (new site = fresh cookies)
        var oldTarget = _targetUri;
        if (oldTarget is null || !oldTarget.Host.Equals(uri.Host, StringComparison.OrdinalIgnoreCase))
        {
            ResetCookieJar();
        }

        _targetUri = uri;
        _targetUrl = uri.ToString();
        return true;
    }

    public void ClearTarget()
    {
        _targetUrl = null;
        _targetUri = null;
        ResetCookieJar();
    }

    public bool HardReload()
    {
        if (_targetUri is null)
            return false;

        ResetCookieJar();
        return true;
    }

    public WebPreviewCookiesResponse GetCookies()
    {
        var target = _targetUri;
        if (target is null)
        {
            return new WebPreviewCookiesResponse();
        }

        lock (_clientLock)
        {
            var cookies = _cookieContainer.GetCookies(target);
            var result = new WebPreviewCookiesResponse
            {
                Header = _cookieContainer.GetCookieHeader(target)
            };

            foreach (Cookie cookie in cookies)
            {
                result.Cookies.Add(new WebPreviewCookieInfo
                {
                    Name = cookie.Name,
                    Value = cookie.Value,
                    Domain = cookie.Domain,
                    Path = cookie.Path,
                    Secure = cookie.Secure,
                    HttpOnly = cookie.HttpOnly,
                    ExpiresUtc = cookie.Expires == DateTime.MinValue
                        ? null
                        : new DateTimeOffset(cookie.Expires.ToUniversalTime())
                });
            }

            return result;
        }
    }

    public bool SetCookieFromRaw(string rawCookie)
    {
        var target = _targetUri;
        if (target is null || string.IsNullOrWhiteSpace(rawCookie))
            return false;

        if (!TryParseCookie(rawCookie, target, out var cookie))
            return false;

        lock (_clientLock)
        {
            try
            {
                if (string.IsNullOrEmpty(cookie.Domain))
                {
                    _cookieContainer.Add(target, cookie);
                }
                else
                {
                    _cookieContainer.Add(cookie);
                }
                return true;
            }
            catch (CookieException)
            {
                return false;
            }
        }
    }

    public bool DeleteCookie(string name, string? path = null, string? domain = null)
    {
        var target = _targetUri;
        if (target is null || string.IsNullOrWhiteSpace(name))
            return false;

        var cookie = new Cookie(name, "")
        {
            Path = string.IsNullOrWhiteSpace(path) ? "/" : path,
            Domain = string.IsNullOrWhiteSpace(domain) ? target.Host : domain.Trim(),
            Expires = DateTime.UtcNow.AddYears(-1)
        };

        lock (_clientLock)
        {
            try
            {
                _cookieContainer.Add(cookie);
                return true;
            }
            catch (CookieException)
            {
                return false;
            }
        }
    }

    private void ResetCookieJar()
    {
        lock (_clientLock)
        {
            var oldClient = _httpClient;
            _cookieContainer = new CookieContainer();
            _httpClient = CreateHttpClient(_cookieContainer);
            oldClient.Dispose();
        }
    }

    public void ConfigureWebSocket(ClientWebSocket ws, Uri upstreamUri)
    {
        ws.Options.RemoteCertificateValidationCallback = ValidateCertificate;

        // Forward cookies from server-side cookie jar so WebSocket connections
        // share the same session context as HTTP requests (critical for SignalR).
        // CookieContainer stores cookies under http(s):// but WebSocket URIs use
        // ws(s)://, so convert the scheme for lookup.
        var httpScheme = upstreamUri.Scheme == "wss" ? "https" : "http";
        var cookieLookupUri = new UriBuilder(upstreamUri) { Scheme = httpScheme }.Uri;
        var cookieHeader = _cookieContainer.GetCookieHeader(cookieLookupUri);
        if (!string.IsNullOrEmpty(cookieHeader))
        {
            ws.Options.SetRequestHeader("Cookie", cookieHeader);
        }
    }

    private bool ValidateCertificate(
        object sender,
        X509Certificate? certificate,
        X509Chain? chain,
        SslPolicyErrors sslPolicyErrors)
    {
        if (sslPolicyErrors == SslPolicyErrors.None)
            return true;

        // Accept self-signed certs for localhost targets
        var target = _targetUri;
        if (target is not null && IsLocalAddress(target.Host))
            return true;

        return false;
    }

    private HttpClient CreateHttpClient(CookieContainer cookieContainer)
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = true,
            CookieContainer = cookieContainer,
            AutomaticDecompression = DecompressionMethods.None,
            ConnectTimeout = TimeSpan.FromSeconds(10),
            SslOptions = new SslClientAuthenticationOptions
            {
                RemoteCertificateValidationCallback = ValidateCertificate
            }
        };

        return new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(5) };
    }

    private static bool IsLocalAddress(string host)
    {
        return host is "localhost" or "127.0.0.1" or "::1"
            || host.Equals("localhost", StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizeUrl(string url)
    {
        url = url.Trim();

        // Auto-prepend https:// if no scheme provided
        if (!url.Contains("://"))
        {
            // Check for localhost/127.0.0.1 patterns — use http for those
            if (url.StartsWith("localhost", StringComparison.OrdinalIgnoreCase)
                || url.StartsWith("127.0.0.1")
                || url.StartsWith("[::1]"))
            {
                url = "http://" + url;
            }
            else
            {
                url = "https://" + url;
            }
        }

        return url;
    }

    private static bool TryParseCookie(string rawCookie, Uri target, out Cookie cookie)
    {
        cookie = new Cookie();
        var parts = rawCookie.Split(';', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0)
            return false;

        var first = parts[0];
        var eqIdx = first.IndexOf('=');
        if (eqIdx <= 0)
            return false;

        var name = first[..eqIdx].Trim();
        var value = first[(eqIdx + 1)..].Trim();
        if (string.IsNullOrWhiteSpace(name))
            return false;

        cookie = new Cookie(name, value)
        {
            Domain = target.Host,
            Path = "/",
            Secure = target.Scheme == "https"
        };

        for (var i = 1; i < parts.Length; i++)
        {
            var part = parts[i];
            var idx = part.IndexOf('=');
            var key = (idx >= 0 ? part[..idx] : part).Trim();
            var attrValue = idx >= 0 ? part[(idx + 1)..].Trim() : "";

            if (key.Equals("Path", StringComparison.OrdinalIgnoreCase))
            {
                if (!string.IsNullOrWhiteSpace(attrValue))
                    cookie.Path = attrValue;
            }
            else if (key.Equals("Domain", StringComparison.OrdinalIgnoreCase))
            {
                if (!string.IsNullOrWhiteSpace(attrValue))
                    cookie.Domain = attrValue.TrimStart('.');
            }
            else if (key.Equals("Secure", StringComparison.OrdinalIgnoreCase))
            {
                cookie.Secure = true;
            }
            else if (key.Equals("HttpOnly", StringComparison.OrdinalIgnoreCase))
            {
                cookie.HttpOnly = true;
            }
            else if (key.Equals("Expires", StringComparison.OrdinalIgnoreCase))
            {
                if (DateTime.TryParse(attrValue, out var expires))
                    cookie.Expires = expires.ToUniversalTime();
            }
            else if (key.Equals("Max-Age", StringComparison.OrdinalIgnoreCase))
            {
                if (int.TryParse(attrValue, out var seconds))
                    cookie.Expires = DateTime.UtcNow.AddSeconds(seconds);
            }
        }

        return true;
    }
}
