using System.Text;
using System.Text.RegularExpressions;
using Ai.Tlbx.MidTerm.Models.WebPreview;
using Ai.Tlbx.MidTerm.Services.Sessions;

namespace Ai.Tlbx.MidTerm.Services.WebPreview;

public static partial class WebPreviewEndpoints
{
    public static void MapWebPreviewEndpoints(
        WebApplication app,
        WebPreviewService webPreviewService,
        TtyHostSessionManager sessionManager)
    {
        MapPreviewSessionEndpoints(app, webPreviewService);
        MapTargetEndpoints(app, webPreviewService, sessionManager);
        MapCookieEndpoints(app, webPreviewService);
        MapActionEndpoints(app, webPreviewService, sessionManager);
        MapProxyLogEndpoints(app, webPreviewService);
    }

    private static void MapPreviewSessionEndpoints(WebApplication app, WebPreviewService service)
    {
        app.MapGet("/api/webpreview/previews", (string sessionId) =>
        {
            return Results.Json(
                service.ListPreviewSessions(sessionId),
                AppJsonContext.Default.WebPreviewSessionListResponse);
        });

        app.MapPost("/api/webpreview/previews", (WebPreviewSessionRequest request) =>
        {
            if (string.IsNullOrWhiteSpace(request.SessionId))
            {
                return Results.BadRequest("sessionId required");
            }

            var response = service.EnsurePreviewSession(request.SessionId, request.PreviewName);
            return Results.Json(response, AppJsonContext.Default.WebPreviewSessionInfo);
        });

        app.MapDelete("/api/webpreview/previews", (string sessionId, string? previewName) =>
        {
            return service.DeletePreviewSession(sessionId, previewName)
                ? Results.Ok()
                : Results.BadRequest("Failed to delete preview.");
        });
    }

    private static void MapTargetEndpoints(WebApplication app, WebPreviewService service, TtyHostSessionManager sessionManager)
    {
        app.MapGet("/api/webpreview/target", (string sessionId, string? previewName) =>
        {
            var response = BuildTargetResponse(service, sessionId, previewName);
            return Results.Json(response, AppJsonContext.Default.WebPreviewTargetResponse);
        });

        app.MapPut("/api/webpreview/target", (WebPreviewTargetRequest request) =>
        {
            if (string.IsNullOrWhiteSpace(request.SessionId))
            {
                return Results.BadRequest("sessionId required");
            }

            if (!service.SetTarget(request.SessionId, request.PreviewName, request.Url))
            {
                return Results.BadRequest("Invalid URL. Must be http://, https://, or a local file:/// URL, and cannot point to this server.");
            }

            WriteMtcliToActiveSessions(sessionManager);

            var response = BuildTargetResponse(service, request.SessionId, request.PreviewName);
            return Results.Json(response, AppJsonContext.Default.WebPreviewTargetResponse);
        });

        app.MapDelete("/api/webpreview/target", (string sessionId, string? previewName) =>
        {
            service.ClearTarget(sessionId, previewName);
            return Results.Ok();
        });
    }

    private static void MapCookieEndpoints(WebApplication app, WebPreviewService service)
    {
        app.MapGet("/api/webpreview/cookies", (string sessionId, string? previewName) =>
        {
            var response = service.GetCookies(sessionId, previewName);
            return Results.Json(response, AppJsonContext.Default.WebPreviewCookiesResponse);
        });

        app.MapPost("/api/webpreview/cookies", (string sessionId, string? previewName, WebPreviewCookieSetRequest request) =>
        {
            if (!service.TryGetPreviewRouteKey(sessionId, previewName, out var routeKey)
                || !service.SetCookieFromRaw(routeKey, request.Raw))
            {
                return Results.BadRequest("Invalid cookie format.");
            }

            var response = service.GetCookies(sessionId, previewName);
            return Results.Json(response, AppJsonContext.Default.WebPreviewCookiesResponse);
        });

        app.MapDelete("/api/webpreview/cookies", (string sessionId, string? previewName, string name, string? path, string? domain) =>
        {
            if (!service.DeleteCookie(sessionId, previewName, name, path, domain))
            {
                return Results.BadRequest("Failed to delete cookie.");
            }

            var response = service.GetCookies(sessionId, previewName);
            return Results.Json(response, AppJsonContext.Default.WebPreviewCookiesResponse);
        });

        app.MapPost("/api/webpreview/cookies/clear", (string sessionId, string? previewName) =>
        {
            if (!service.ClearAllCookies(sessionId, previewName))
                return Results.BadRequest("No active target.");
            return Results.Ok();
        });
    }

    private static void MapActionEndpoints(WebApplication app, WebPreviewService service, TtyHostSessionManager sessionManager)
    {
        app.MapPost("/api/webpreview/reload", (WebPreviewReloadRequest request) =>
        {
            if (request.Mode.Equals("hard", StringComparison.OrdinalIgnoreCase))
            {
                if (string.IsNullOrWhiteSpace(request.SessionId) || !service.HardReload(request.SessionId, request.PreviewName))
                {
                    return Results.BadRequest("No active target.");
                }
            }
            return Results.Ok();
        });

        app.MapPost("/api/webpreview/snapshot", async (
            WebPreviewSnapshotRequest request) =>
        {
            var session = sessionManager.GetSession(request.SessionId);
            if (session is null)
                return Results.NotFound("Session not found");

            var cwd = session.CurrentDirectory;
            if (string.IsNullOrEmpty(cwd) || !Directory.Exists(cwd))
                return Results.BadRequest("Session has no valid working directory");

            var ts = DateTime.Now.ToString("yyyyMMdd_HHmmss");
            var snapshotDir = MidtermDirectory.EnsureSubdirectory(cwd, $"snapshot_{ts}");
            var cssDir = Path.Combine(snapshotDir, "css");
            Directory.CreateDirectory(cssDir);

            // Process HTML — strip proxy artifacts, decode ext URLs
            var html = StripProxyArtifacts(request.Html);
            html = DecodeExtUrls(html);

            // Download CSS files and rewrite hrefs
            foreach (var cssUrl in request.CssUrls.Distinct())
            {
                if (!TryExtractProxyPath(cssUrl, out var routeKey, out var proxyPath))
                    continue;

                string upstreamUrl;
                if (proxyPath.StartsWith("/_ext", StringComparison.Ordinal))
                {
                    var qIdx = proxyPath.IndexOf("?u=", StringComparison.Ordinal);
                    if (qIdx < 0) continue;
                    var encoded = proxyPath[(qIdx + 3)..];
                    try { upstreamUrl = Uri.UnescapeDataString(encoded); }
                    catch { continue; }
                }
                else if (service.GetTargetUriByRouteKey(routeKey) is { } targetUri)
                {
                    upstreamUrl = BuildUpstreamUrl(targetUri, proxyPath);
                }
                else
                {
                    continue;
                }

                var rawName = proxyPath.Split('?')[0].Split('/').LastOrDefault() ?? "style";
                var baseName = Path.GetFileNameWithoutExtension(rawName);
                var fileName = SanitizeFileName(baseName) + ".css";

                var finalFileName = fileName;
                var counter = 1;
                while (File.Exists(Path.Combine(cssDir, finalFileName)))
                {
                    finalFileName = $"{Path.GetFileNameWithoutExtension(fileName)}_{counter}.css";
                    counter++;
                }

                try
                {
                    var cssContent = await service.GetHttpClient(routeKey).GetStringAsync(upstreamUrl);
                    await File.WriteAllTextAsync(Path.Combine(cssDir, finalFileName), cssContent);

                    html = html.Replace(cssUrl, $"css/{finalFileName}", StringComparison.Ordinal);

                    var pathNoQuery = proxyPath.Split('?')[0];
                    html = html.Replace($"\"{pathNoQuery}\"", $"\"css/{finalFileName}\"", StringComparison.Ordinal);
                    html = html.Replace($"'{pathNoQuery}'", $"'css/{finalFileName}'", StringComparison.Ordinal);
                }
                catch
                {
                    // Skip failed assets — snapshot is still useful without them
                }
            }

            await File.WriteAllTextAsync(Path.Combine(snapshotDir, "index.html"), html);

            return Results.Json(
                new WebPreviewSnapshotResponse { SnapshotPath = snapshotDir },
                AppJsonContext.Default.WebPreviewSnapshotResponse);
        });
    }

    private static void MapProxyLogEndpoints(WebApplication app, WebPreviewService service)
    {
        app.MapGet("/api/webpreview/proxylog", (string sessionId, string? previewName, int? limit) =>
        {
            var entries = service.GetLogEntries(sessionId, previewName, limit ?? 100);
            return Results.Json(entries, AppJsonContext.Default.ListWebPreviewProxyLogEntry);
        });

        app.MapDelete("/api/webpreview/proxylog", (string sessionId, string? previewName) =>
        {
            service.ClearLog(sessionId, previewName);
            return Results.Ok();
        });
    }

    /// <summary>
    /// Removes proxy-injected artifacts from the captured DOM HTML:
    /// the <base> tag, the MT proxy script, and any blob: script tags.
    /// </summary>
    private static string StripProxyArtifacts(string html)
    {
        html = BaseTagRegex().Replace(html, "");
        html = ProxyScriptRegex().Replace(html, "");
        html = BlobScriptRegex().Replace(html, "");
        return html;
    }

    /// <summary>
    /// Replaces /_ext?u=ENCODED proxy URLs with the decoded original URLs.
    /// </summary>
    private static string DecodeExtUrls(string html)
    {
        return ExtUrlRegex().Replace(html, m =>
        {
            try { return Uri.UnescapeDataString(m.Groups[1].Value); }
            catch { return m.Value; }
        });
    }

    /// <summary>
    /// Extracts the path+query portion from an absolute browser URL, returning
    /// true only if it passes through the /webpreview proxy prefix.
    /// </summary>
    private static bool TryExtractProxyPath(string absoluteUrl, out string routeKey, out string proxyPath)
    {
        routeKey = "";
        proxyPath = "";
        if (!Uri.TryCreate(absoluteUrl, UriKind.Absolute, out var uri))
            return false;

        if (!WebPreviewProxyMiddleware.TryParseProxyRoute(uri.AbsolutePath, out routeKey, out var remainingPath))
            return false;

        proxyPath = remainingPath + uri.Query;
        return true;
    }

    private static WebPreviewTargetResponse BuildTargetResponse(WebPreviewService service, string sessionId, string? previewName)
    {
        var preview = service.EnsurePreviewSession(sessionId, previewName);
        return new WebPreviewTargetResponse
        {
            SessionId = preview.SessionId,
            PreviewName = preview.PreviewName,
            RouteKey = preview.RouteKey,
            Url = preview.Url,
            Active = preview.Active,
            TargetRevision = preview.TargetRevision
        };
    }

    private static void WriteMtcliToActiveSessions(TtyHostSessionManager sessionManager)
    {
        var sessions = sessionManager.GetAllSessions();
        foreach (var session in sessions)
        {
            var cwd = session.CurrentDirectory;
            if (!string.IsNullOrEmpty(cwd) && Directory.Exists(cwd))
            {
                MidtermDirectory.Ensure(cwd);
            }
        }
    }

    /// <summary>
    /// Strips the /webpreview prefix from a proxy path and prepends the upstream origin.
    /// e.g. /webpreview/typo3temp/style.css → http://upstream.host/typo3temp/style.css
    /// </summary>
    private static string BuildUpstreamUrl(Uri targetUri, string proxyPath)
    {
        return targetUri.GetLeftPart(UriPartial.Authority) + proxyPath;
    }

    /// <summary>
    /// Returns a filesystem-safe version of a filename, replacing invalid chars with underscores.
    /// </summary>
    private static string SanitizeFileName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var sb = new StringBuilder(name.Length);
        foreach (var c in name)
        {
            sb.Append(Array.IndexOf(invalid, c) >= 0 || c == '?' ? '_' : c);
        }
        var result = sb.ToString().Trim('_');
        return string.IsNullOrEmpty(result) ? "style" : result;
    }

    // Strips <base href="..."> or <base target="..."> tags
    [GeneratedRegex(@"<base\s[^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex BaseTagRegex();

    // Strips the MT proxy shim script (the minified IIFE containing window.__mtProxy)
    [GeneratedRegex(@"<script>\(function\(\)\{.*?window\.__mtProxy.*?</script>", RegexOptions.Singleline)]
    private static partial Regex ProxyScriptRegex();

    // Strips <script src="blob:..."> tags injected at runtime (e.g. by html2canvas loader)
    [GeneratedRegex(@"<script[^>]+src=[""']blob:[^""'>]+[""'][^>]*></script>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex BlobScriptRegex();

    // Matches /_ext?u=ENCODED_URL patterns for decoding
    [GeneratedRegex(@"/_ext\?u=([^&""'\s>]+)")]
    private static partial Regex ExtUrlRegex();
}
