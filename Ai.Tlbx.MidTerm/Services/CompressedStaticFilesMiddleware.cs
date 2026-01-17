using System.IO.Compression;
using Microsoft.Extensions.FileProviders;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class CompressedStaticFilesMiddleware
{
    private readonly RequestDelegate _next;
    private readonly IFileProvider _fileProvider;

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

        var acceptEncoding = context.Request.Headers.AcceptEncoding.ToString();
        var clientSupportsBrotli = acceptEncoding.Contains("br", StringComparison.OrdinalIgnoreCase);

        context.Response.ContentType = contentType;
        context.Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
        context.Response.Headers.Pragma = "no-cache";

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
