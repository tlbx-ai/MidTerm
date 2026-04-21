using System.Text;
using Ai.Tlbx.MidTerm.Services.StaticFiles;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Primitives;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class CompressedStaticFilesMiddlewareTests
{
    [Fact]
    public async Task InvokeAsync_WhenBrotliSidecarIsStale_FallsBackToNextMiddleware()
    {
        var provider = new TestFileProvider(
            new TestFileInfo("js/terminal.min.js", "fresh", new DateTimeOffset(2026, 3, 26, 0, 30, 0, TimeSpan.Zero)),
            new TestFileInfo("js/terminal.min.js.br", "stale", new DateTimeOffset(2026, 3, 10, 0, 22, 18, TimeSpan.Zero))
        );

        var nextCalled = false;
        var middleware = new CompressedStaticFilesMiddleware(
            async context =>
            {
                nextCalled = true;
                await context.Response.WriteAsync("next", context.RequestAborted);
            },
            provider
        );

        var context = new DefaultHttpContext();
        context.Request.Path = "/js/terminal.min.js";
        context.Request.Headers.AcceptEncoding = "br,gzip";
        context.Response.Body = new MemoryStream();

        await middleware.InvokeAsync(context);

        context.Response.Body.Position = 0;
        using var reader = new StreamReader(context.Response.Body, Encoding.UTF8, leaveOpen: true);
        var body = await reader.ReadToEndAsync(context.RequestAborted);

        Assert.True(nextCalled);
        Assert.Equal("next", body);
        Assert.False(context.Response.Headers.ContainsKey("Content-Encoding"));
    }

    [Fact]
    public async Task InvokeAsync_WhenBrotliSidecarIsCurrent_ServesCompressedAsset()
    {
        var provider = new TestFileProvider(
            new TestFileInfo("js/terminal.min.js", "fresh", new DateTimeOffset(2026, 3, 10, 0, 22, 16, TimeSpan.Zero)),
            new TestFileInfo("js/terminal.min.js.br", "compressed", new DateTimeOffset(2026, 3, 25, 23, 22, 18, TimeSpan.Zero))
        );

        var nextCalled = false;
        var middleware = new CompressedStaticFilesMiddleware(
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            provider
        );

        var context = new DefaultHttpContext();
        context.Request.Path = "/js/terminal.min.js";
        context.Request.Headers.AcceptEncoding = "br,gzip";
        context.Response.Body = new MemoryStream();

        await middleware.InvokeAsync(context);

        context.Response.Body.Position = 0;
        using var reader = new StreamReader(context.Response.Body, Encoding.UTF8, leaveOpen: true);
        var body = await reader.ReadToEndAsync(context.RequestAborted);

        Assert.False(nextCalled);
        Assert.Equal("compressed", body);
        Assert.Equal("br", context.Response.Headers.ContentEncoding.ToString());
        Assert.Equal("application/javascript", context.Response.ContentType);
    }

    private sealed class TestFileProvider(params TestFileInfo[] files) : IFileProvider
    {
        private readonly Dictionary<string, TestFileInfo> _files = files.ToDictionary(
            file => file.Path,
            file => file,
            StringComparer.OrdinalIgnoreCase
        );

        public IFileInfo GetFileInfo(string subpath)
        {
            return _files.TryGetValue(Normalize(subpath), out var file) ? file : new NotFoundFileInfo(subpath);
        }

        public IDirectoryContents GetDirectoryContents(string subpath)
        {
            return NotFoundDirectoryContents.Singleton;
        }

        public IChangeToken Watch(string filter)
        {
            return NullChangeToken.Singleton;
        }

        private static string Normalize(string path)
        {
            return path.TrimStart('/').Replace('\\', '/');
        }
    }

    private sealed class TestFileInfo(string path, string content, DateTimeOffset lastModified) : IFileInfo
    {
        private readonly byte[] _content = Encoding.UTF8.GetBytes(content);

        public string Path { get; } = path.Replace('\\', '/');
        public bool Exists => true;
        public long Length => _content.Length;
        public string? PhysicalPath => null;
        public string Name => System.IO.Path.GetFileName(Path);
        public DateTimeOffset LastModified { get; } = lastModified;
        public bool IsDirectory => false;

        public Stream CreateReadStream()
        {
            return new MemoryStream(_content, writable: false);
        }
    }
}
