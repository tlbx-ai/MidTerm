using System.IO.Compression;
using System.Reflection;
using Microsoft.Extensions.FileProviders;

namespace Ai.Tlbx.MidTerm.Services.StaticFiles;

public sealed class CompressedStaticFilesMiddleware
{
    private readonly RequestDelegate _next;
    private readonly IFileProvider _fileProvider;
    private readonly string _versionETag;

    private static readonly Dictionary<string, string> CompressibleExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        [".js"] = "application/javascript",
        [".css"] = "text/css",
        [".html"] = "text/html",
        [".txt"] = "text/plain",
        [".json"] = "application/json",
        [".map"] = "application/json",
        [".svg"] = "image/svg+xml",
        [".webmanifest"] = "application/manifest+json",
        [".woff"] = "font/woff",
        [".woff2"] = "font/woff2",
        [".ico"] = "image/x-icon"
    };

    public CompressedStaticFilesMiddleware(RequestDelegate next, IFileProvider fileProvider)
    {
        _next = next;
        _fileProvider = fileProvider;

        var version = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown";
        var plusIndex = version.IndexOf('+');
        if (plusIndex > 0) version = version[..plusIndex];
        _versionETag = $"\"{version}\"";
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path.Value;
        if (string.IsNullOrEmpty(path))
        {
            await _next(context);
            return;
        }

        // Handle root path - serve index.html.br
        if (path == "/")
        {
            path = "/index.html";
        }

        var extension = Path.GetExtension(path);

        // Handle extensionless paths - try .html
        if (string.IsNullOrEmpty(extension))
        {
            var htmlPath = path + ".html";
            var htmlBrPath = htmlPath + ".br";
            var htmlFileInfo = _fileProvider.GetFileInfo(htmlBrPath.TrimStart('/'));
            if (htmlFileInfo.Exists)
            {
                path = htmlPath;
                extension = ".html";
            }
        }

        if (!CompressibleExtensions.TryGetValue(extension, out var contentType))
        {
            await _next(context);
            return;
        }

        var brPath = path + ".br";
        var fileInfo = _fileProvider.GetFileInfo(brPath.TrimStart('/'));

        if (!fileInfo.Exists)
        {
            await _next(context);
            return;
        }

        // ETag-based 304 Not Modified
        var ifNoneMatch = context.Request.Headers.IfNoneMatch.ToString();
        if (!string.IsNullOrEmpty(ifNoneMatch) && ifNoneMatch.Contains(_versionETag))
        {
            context.Response.StatusCode = StatusCodes.Status304NotModified;
            context.Response.Headers.ETag = _versionETag;
            return;
        }

        var acceptEncoding = context.Request.Headers.AcceptEncoding.ToString();
        var clientSupportsBrotli = acceptEncoding.Contains("br", StringComparison.OrdinalIgnoreCase);

        context.Response.ContentType = contentType;
        context.Response.Headers.ETag = _versionETag;

        // Revalidate entry-point assets on every navigation so UI updates are visible
        // immediately after an app update, even in PWA mode.
        var shouldRevalidate = extension.Equals(".html", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".css", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".js", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".webmanifest", StringComparison.OrdinalIgnoreCase);
        context.Response.Headers.CacheControl = shouldRevalidate
            ? "public, max-age=0, must-revalidate"
            : "public, max-age=86400";

        await using var fileStream = fileInfo.CreateReadStream();

        if (clientSupportsBrotli)
        {
            context.Response.Headers.ContentEncoding = "br";
            context.Response.ContentLength = fileInfo.Length;
            await fileStream.CopyToAsync(context.Response.Body);
        }
        else
        {
            await using var brotliStream = new BrotliStream(fileStream, CompressionMode.Decompress);
            await brotliStream.CopyToAsync(context.Response.Body);
        }
    }
}
