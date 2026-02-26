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
    private readonly string? _cookiesDirectory;

    private HttpClient _httpClient;
    private CookieContainer _cookieContainer;
    private readonly object _clientLock = new();

    public string? TargetUrl => _targetUrl;
    public Uri? TargetUri => _targetUri;
    public bool IsActive => _targetUri is not null;

    public WebPreviewService(int serverPort, string? cookiesDirectory = null)
    {
        _serverPort = serverPort;
        _cookiesDirectory = cookiesDirectory;
        _cookieContainer = new CookieContainer();
        _httpClient = CreateHttpClient(_cookieContainer);
    }

    public HttpClient HttpClient => _httpClient;

    public bool SetTarget(string url)
    {
        if (string.IsNullOrWhiteSpace(url))
            return false;

        url = NormalizeUrl(url);

        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return false;

        if (uri.Scheme is not ("http" or "https"))
            return false;

        // Prevent self-proxying
        if (IsLocalAddress(uri.Host) && uri.Port == _serverPort)
            return false;

        var oldTarget = _targetUri;
        if (oldTarget is null || !oldTarget.Host.Equals(uri.Host, StringComparison.OrdinalIgnoreCase))
        {
            ResetCookieJar();
        }

        _targetUri = uri;
        _targetUrl = uri.ToString();
        LoadCookiesFromDisk(uri);
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
        var target = _targetUri;
        if (target is null)
            return false;

        DeleteCookieFile(target);
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
                PersistCookiesLocked(target);
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
                PersistCookiesLocked(target);
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

    public void PersistCookies()
    {
        var target = _targetUri;
        if (target is null)
            return;

        lock (_clientLock)
        {
            PersistCookiesLocked(target);
        }
    }

    private void PersistCookiesLocked(Uri target)
    {
        var filePath = GetCookieFilePath(target);
        if (filePath is null)
            return;

        try
        {
            var cookies = _cookieContainer.GetAllCookies();
            var lines = new List<string>();
            foreach (Cookie cookie in cookies)
            {
                if (cookie.Expired)
                    continue;
                lines.Add(FormatCookie(cookie));
            }

            if (lines.Count == 0)
            {
                File.Delete(filePath);
                return;
            }

            Directory.CreateDirectory(_cookiesDirectory!);
            File.WriteAllLines(filePath, lines);
        }
        catch
        {
            // Best-effort persistence — don't break the proxy
        }
    }

    private void LoadCookiesFromDisk(Uri target)
    {
        var filePath = GetCookieFilePath(target);
        if (filePath is null || !File.Exists(filePath))
            return;

        try
        {
            var lines = File.ReadAllLines(filePath);
            lock (_clientLock)
            {
                foreach (var line in lines)
                {
                    if (string.IsNullOrWhiteSpace(line))
                        continue;

                    if (!TryParseCookie(line, target, out var cookie))
                        continue;

                    if (cookie.Expired)
                        continue;

                    try
                    {
                        if (string.IsNullOrEmpty(cookie.Domain))
                            _cookieContainer.Add(target, cookie);
                        else
                            _cookieContainer.Add(cookie);
                    }
                    catch (CookieException)
                    {
                        // Skip malformed cookies
                    }
                }
            }
        }
        catch
        {
            // Best-effort load — don't block target activation
        }
    }

    private void DeleteCookieFile(Uri target)
    {
        var filePath = GetCookieFilePath(target);
        if (filePath is null)
            return;

        try
        {
            File.Delete(filePath);
        }
        catch
        {
            // Best-effort delete
        }
    }

    private string? GetCookieFilePath(Uri target)
    {
        if (_cookiesDirectory is null)
            return null;

        var host = target.Host.Replace(':', '_');
        var fileName = $"{host}_{target.Port}.txt";
        return Path.Combine(_cookiesDirectory, fileName);
    }

    private static string FormatCookie(Cookie cookie)
    {
        var parts = new List<string>
        {
            $"{cookie.Name}={cookie.Value}",
            $"Domain={cookie.Domain}",
            $"Path={cookie.Path}"
        };

        if (cookie.Secure)
            parts.Add("Secure");
        if (cookie.HttpOnly)
            parts.Add("HttpOnly");
        if (cookie.Expires != DateTime.MinValue)
            parts.Add($"Expires={cookie.Expires.ToUniversalTime():R}");

        return string.Join("; ", parts);
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
