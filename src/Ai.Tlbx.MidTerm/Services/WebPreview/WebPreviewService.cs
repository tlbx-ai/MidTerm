using System.Collections.Concurrent;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
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

    private const int MaxLogEntries = 100;
    private readonly ConcurrentQueue<WebPreviewProxyLogEntry> _proxyLog = new();
    private int _logIdCounter;

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

    public void AddLogEntry(WebPreviewProxyLogEntry entry)
    {
        entry.Id = Interlocked.Increment(ref _logIdCounter);
        entry.Timestamp = DateTimeOffset.UtcNow;
        _proxyLog.Enqueue(entry);
        while (_proxyLog.Count > MaxLogEntries)
            _proxyLog.TryDequeue(out _);
    }

    public List<WebPreviewProxyLogEntry> GetLogEntries(int limit = MaxLogEntries)
    {
        var entries = _proxyLog.ToArray();
        if (limit >= entries.Length)
            return entries.ToList();
        return entries[^limit..].ToList();
    }

    public void ClearLog()
    {
        while (_proxyLog.TryDequeue(out _)) { }
    }

    public bool SetTarget(string url, bool preserveCookies = false)
    {
        if (string.IsNullOrWhiteSpace(url))
            return false;

        url = NormalizeUrl(url);

        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return false;

        if (uri.Scheme is not ("http" or "https"))
            return false;

        // Prevent self-proxying
        if (IsThisServerTarget(uri))
            return false;

        var oldTarget = _targetUri;
        if (oldTarget is null || !TargetsShareCookieScope(oldTarget, uri))
        {
            if (!preserveCookies)
            {
                ResetCookieJar();
            }
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

    public bool ClearAllCookies()
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
            var cookies = _cookieContainer.GetAllCookies();
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

    public WebPreviewCookiesResponse GetBrowserCookies(Uri? requestUri = null)
    {
        var target = requestUri ?? _targetUri;
        if (target is null)
        {
            return new WebPreviewCookiesResponse();
        }

        lock (_clientLock)
        {
            var cookies = GetMatchingCookiesLocked(target, includeHttpOnly: false);
            var result = new WebPreviewCookiesResponse
            {
                Header = BuildCookieHeader(cookies)
            };

            foreach (var cookie in cookies)
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

    public bool SetCookieFromRaw(string rawCookie, Uri? requestUri = null, bool allowHttpOnly = true)
    {
        var target = requestUri ?? _targetUri;
        if (target is null || string.IsNullOrWhiteSpace(rawCookie))
            return false;

        if (!TryParseCookie(rawCookie, target, out var cookie))
            return false;

        if (!allowHttpOnly && cookie.HttpOnly)
        {
            cookie.HttpOnly = false;
        }

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

    private List<Cookie> GetMatchingCookiesLocked(Uri requestUri, bool includeHttpOnly)
    {
        var cookies = new List<Cookie>();
        foreach (Cookie cookie in _cookieContainer.GetAllCookies())
        {
            if (cookie.Expired)
                continue;
            if (!includeHttpOnly && cookie.HttpOnly)
                continue;
            if (!CookieMatchesRequestUri(cookie, requestUri))
                continue;
            cookies.Add(cookie);
        }

        cookies.Sort((a, b) =>
        {
            var pathCompare = (b.Path?.Length ?? 0).CompareTo(a.Path?.Length ?? 0);
            if (pathCompare != 0)
                return pathCompare;
            return string.Compare(a.Name, b.Name, StringComparison.Ordinal);
        });

        return cookies;
    }

    private static string BuildCookieHeader(IEnumerable<Cookie> cookies)
    {
        return string.Join("; ", cookies.Select(cookie => $"{cookie.Name}={cookie.Value}"));
    }

    private static bool CookieMatchesRequestUri(Cookie cookie, Uri requestUri)
    {
        if (cookie.Secure && requestUri.Scheme != Uri.UriSchemeHttps)
            return false;

        if (!DomainMatches(cookie.Domain, requestUri.Host))
            return false;

        return PathMatches(cookie.Path, requestUri.AbsolutePath);
    }

    private static bool DomainMatches(string cookieDomain, string requestHost)
    {
        var normalizedDomain = cookieDomain.Trim().TrimStart('.');
        if (string.IsNullOrEmpty(normalizedDomain))
            return false;

        return requestHost.Equals(normalizedDomain, StringComparison.OrdinalIgnoreCase)
            || requestHost.EndsWith("." + normalizedDomain, StringComparison.OrdinalIgnoreCase);
    }

    private static bool PathMatches(string cookiePath, string requestPath)
    {
        var normalizedCookiePath = string.IsNullOrWhiteSpace(cookiePath) ? "/" : cookiePath;
        if (!normalizedCookiePath.StartsWith('/'))
            normalizedCookiePath = "/" + normalizedCookiePath;

        var normalizedRequestPath = string.IsNullOrEmpty(requestPath) ? "/" : requestPath;
        if (!normalizedRequestPath.StartsWith('/'))
            normalizedRequestPath = "/" + normalizedRequestPath;

        if (normalizedRequestPath.Equals(normalizedCookiePath, StringComparison.Ordinal))
            return true;

        if (!normalizedRequestPath.StartsWith(normalizedCookiePath, StringComparison.Ordinal))
            return false;

        return normalizedCookiePath.EndsWith("/", StringComparison.Ordinal)
            || normalizedRequestPath.Length > normalizedCookiePath.Length
            && normalizedRequestPath[normalizedCookiePath.Length] == '/';
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

    private bool IsThisServerTarget(Uri uri)
    {
        if (uri.Port != _serverPort)
            return false;

        if (IsLocalAddress(uri.Host))
            return true;

        if (uri.Host.Equals(Environment.MachineName, StringComparison.OrdinalIgnoreCase))
            return true;

        string? dnsHostName = null;
        try
        {
            dnsHostName = Dns.GetHostName();
        }
        catch (SocketException)
        {
        }

        if (!string.IsNullOrEmpty(dnsHostName)
            && uri.Host.Equals(dnsHostName, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        foreach (var address in ResolveHostAddresses(uri.Host))
        {
            if (IPAddress.IsLoopback(address))
                return true;

            foreach (var localAddress in ResolveLocalAddresses(dnsHostName))
            {
                if (address.Equals(localAddress))
                    return true;
            }
        }

        return false;
    }

    private static IEnumerable<IPAddress> ResolveHostAddresses(string host)
    {
        if (IPAddress.TryParse(host, out var parsed))
        {
            yield return parsed;
            yield break;
        }

        IPAddress[] addresses;
        try
        {
            addresses = Dns.GetHostAddresses(host);
        }
        catch (SocketException)
        {
            yield break;
        }
        catch (ArgumentException)
        {
            yield break;
        }

        foreach (var address in addresses)
        {
            yield return address;
        }
    }

    private static IEnumerable<IPAddress> ResolveLocalAddresses(string? dnsHostName)
    {
        if (string.IsNullOrEmpty(dnsHostName))
            yield break;

        IPAddress[] addresses;
        try
        {
            addresses = Dns.GetHostAddresses(dnsHostName);
        }
        catch (SocketException)
        {
            yield break;
        }

        foreach (var address in addresses)
        {
            yield return address;
        }
    }

    private static bool TargetsShareCookieScope(Uri left, Uri right)
    {
        return left.Authority.Equals(right.Authority, StringComparison.OrdinalIgnoreCase);
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
