using System.Text;
using System.Text.RegularExpressions;
using Ai.Tlbx.MidTerm.Models.WebPreview;
using Ai.Tlbx.MidTerm.Services.Sessions;

namespace Ai.Tlbx.MidTerm.Services.WebPreview;

public static partial class WebPreviewEndpoints
{
    private const string ClaudeMdContent =
        """
        # MidTerm Web Preview Snapshots

        This folder is managed by MidTerm (https://github.com/tlbx-ai/MidTerm),
        a web-based terminal multiplexer with a built-in web preview panel.

        ## What are snapshots?
        When the web preview panel is open, clicking the 💾 button saves the
        **live rendered DOM** (not the raw server HTML) as a local file tree:

          .midterm/snapshot_YYYYMMDD_HHMMSS/
          ├── index.html   ← full rendered DOM, JS-modified content included
          └── css/         ← CSS stylesheets referenced by the page

        The snapshot captures what the browser actually rendered, including
        content injected by JavaScript frameworks, SPAs, etc.

        ## Using snapshots for debugging
        - Read index.html to understand page structure and element IDs/classes
        - Read css/ files to understand layout, theming, and visual rules
        - External resources (images, scripts) reference their original URLs
        - The snapshot is static — no JavaScript runs from these files

        ## Notes
        - snapshot_*/ folders are gitignored (see .gitignore in this folder)
        - CLAUDE.md (this file) is safe to commit — helps teammates' AI agents
        """;

    public static void MapWebPreviewEndpoints(WebApplication app, WebPreviewService webPreviewService, TtyHostSessionManager sessionManager)
    {
        app.MapGet("/api/webpreview/target", () =>
        {
            var response = new WebPreviewTargetResponse
            {
                Url = webPreviewService.TargetUrl,
                Active = webPreviewService.IsActive
            };
            return Results.Json(response, AppJsonContext.Default.WebPreviewTargetResponse);
        });

        app.MapPut("/api/webpreview/target", (WebPreviewTargetRequest request) =>
        {
            if (!webPreviewService.SetTarget(request.Url))
            {
                return Results.BadRequest("Invalid URL. Must be http:// or https:// and cannot point to this server.");
            }

            var response = new WebPreviewTargetResponse
            {
                Url = webPreviewService.TargetUrl,
                Active = webPreviewService.IsActive
            };
            return Results.Json(response, AppJsonContext.Default.WebPreviewTargetResponse);
        });

        app.MapDelete("/api/webpreview/target", () =>
        {
            webPreviewService.ClearTarget();
            return Results.Ok();
        });

        app.MapGet("/api/webpreview/cookies", () =>
        {
            var response = webPreviewService.GetCookies();
            return Results.Json(response, AppJsonContext.Default.WebPreviewCookiesResponse);
        });

        app.MapPost("/api/webpreview/cookies", (WebPreviewCookieSetRequest request) =>
        {
            if (!webPreviewService.SetCookieFromRaw(request.Raw))
            {
                return Results.BadRequest("Invalid cookie format.");
            }

            var response = webPreviewService.GetCookies();
            return Results.Json(response, AppJsonContext.Default.WebPreviewCookiesResponse);
        });

        app.MapDelete("/api/webpreview/cookies", (string name, string? path, string? domain) =>
        {
            if (!webPreviewService.DeleteCookie(name, path, domain))
            {
                return Results.BadRequest("Failed to delete cookie.");
            }

            var response = webPreviewService.GetCookies();
            return Results.Json(response, AppJsonContext.Default.WebPreviewCookiesResponse);
        });

        app.MapPost("/api/webpreview/reload", (WebPreviewReloadRequest request) =>
        {
            if (request.Mode.Equals("hard", StringComparison.OrdinalIgnoreCase))
            {
                webPreviewService.HardReload();
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

            // Create snapshot folder
            var ts = DateTime.Now.ToString("yyyyMMdd_HHmmss");
            var midtermDir = Path.Combine(cwd, ".midterm");
            var snapshotDir = Path.Combine(midtermDir, $"snapshot_{ts}");
            var cssDir = Path.Combine(snapshotDir, "css");
            Directory.CreateDirectory(cssDir);

            // Process HTML — strip proxy artifacts, decode ext URLs
            var html = StripProxyArtifacts(request.Html);
            html = DecodeExtUrls(html);

            // Download CSS files and rewrite hrefs
            foreach (var cssUrl in request.CssUrls.Distinct())
            {
                if (!TryExtractProxyPath(cssUrl, out var proxyPath))
                    continue;

                string upstreamUrl;
                if (proxyPath.StartsWith("/webpreview/_ext", StringComparison.Ordinal))
                {
                    // External CSS routed through the proxy: /webpreview/_ext?u=ENCODED
                    var qIdx = proxyPath.IndexOf("?u=", StringComparison.Ordinal);
                    if (qIdx < 0) continue;
                    var encoded = proxyPath[(qIdx + 3)..];
                    try { upstreamUrl = Uri.UnescapeDataString(encoded); }
                    catch { continue; }
                }
                else if (webPreviewService.TargetUri is not null)
                {
                    upstreamUrl = BuildUpstreamUrl(webPreviewService.TargetUri, proxyPath);
                }
                else
                {
                    continue;
                }

                // Derive a safe filename from the path component
                var rawName = proxyPath.Split('?')[0].Split('/').LastOrDefault() ?? "style";
                var baseName = Path.GetFileNameWithoutExtension(rawName);
                var fileName = SanitizeFileName(baseName) + ".css";

                // Avoid filename collisions
                var finalFileName = fileName;
                var counter = 1;
                while (File.Exists(Path.Combine(cssDir, finalFileName)))
                {
                    finalFileName = $"{Path.GetFileNameWithoutExtension(fileName)}_{counter}.css";
                    counter++;
                }

                try
                {
                    var cssContent = await webPreviewService.HttpClient.GetStringAsync(upstreamUrl);
                    await File.WriteAllTextAsync(Path.Combine(cssDir, finalFileName), cssContent);

                    // Replace absolute browser URL
                    html = html.Replace(cssUrl, $"css/{finalFileName}", StringComparison.Ordinal);

                    // Replace root-relative proxy path (without query string), both quote styles
                    var pathNoQuery = proxyPath.Split('?')[0];
                    html = html.Replace($"\"{pathNoQuery}\"", $"\"css/{finalFileName}\"", StringComparison.Ordinal);
                    html = html.Replace($"'{pathNoQuery}'", $"'css/{finalFileName}'", StringComparison.Ordinal);
                }
                catch
                {
                    // Skip failed assets — snapshot is still useful without them
                }
            }

            // Save index.html
            await File.WriteAllTextAsync(Path.Combine(snapshotDir, "index.html"), html);

            // Create .gitignore once
            var gitignorePath = Path.Combine(midtermDir, ".gitignore");
            if (!File.Exists(gitignorePath))
                await File.WriteAllTextAsync(gitignorePath, "snapshot_*/\n");

            // Create CLAUDE.md once
            var claudeMdPath = Path.Combine(midtermDir, "CLAUDE.md");
            if (!File.Exists(claudeMdPath))
                await File.WriteAllTextAsync(claudeMdPath, ClaudeMdContent);

            return Results.Json(
                new WebPreviewSnapshotResponse { SnapshotPath = snapshotDir },
                AppJsonContext.Default.WebPreviewSnapshotResponse);
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
    private static bool TryExtractProxyPath(string absoluteUrl, out string proxyPath)
    {
        proxyPath = "";
        if (!Uri.TryCreate(absoluteUrl, UriKind.Absolute, out var uri))
            return false;

        var path = uri.PathAndQuery;
        if (!path.StartsWith("/webpreview", StringComparison.Ordinal))
            return false;

        proxyPath = path;
        return true;
    }

    /// <summary>
    /// Strips the /webpreview prefix from a proxy path and prepends the upstream origin.
    /// e.g. /webpreview/typo3temp/style.css → http://upstream.host/typo3temp/style.css
    /// </summary>
    private static string BuildUpstreamUrl(Uri targetUri, string proxyPath)
    {
        // Strip /webpreview (length 11) to keep the leading /
        var upstreamPath = proxyPath.StartsWith("/webpreview/", StringComparison.Ordinal)
            ? proxyPath["/webpreview".Length..]
            : "/";

        return targetUri.GetLeftPart(UriPartial.Authority) + upstreamPath;
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
