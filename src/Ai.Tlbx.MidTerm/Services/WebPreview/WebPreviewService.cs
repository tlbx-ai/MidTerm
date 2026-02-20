using System.Net;
using System.Net.Security;
using System.Net.WebSockets;
using System.Security.Cryptography.X509Certificates;

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

    public void ConfigureWebSocket(ClientWebSocket ws)
    {
        ws.Options.RemoteCertificateValidationCallback = ValidateCertificate;
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
}
