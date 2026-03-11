using Ai.Tlbx.MidTerm.Services.StaticFiles;
using Microsoft.Extensions.FileProviders;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class StaticAssetCacheHeadersTests
{
    [Fact]
    public void CreateETag_SamePathAndMetadata_ReturnsStableValue()
    {
        var fileInfo = new TestFileInfo(1024, new DateTimeOffset(2026, 3, 10, 12, 0, 0, TimeSpan.Zero));

        var first = StaticAssetCacheHeaders.CreateETag("/js/terminal.min.js", fileInfo);
        var second = StaticAssetCacheHeaders.CreateETag("/js/terminal.min.js", fileInfo);

        Assert.Equal(first, second);
    }

    [Fact]
    public void CreateETag_DifferentPath_ReturnsDifferentValue()
    {
        var fileInfo = new TestFileInfo(1024, new DateTimeOffset(2026, 3, 10, 12, 0, 0, TimeSpan.Zero));

        var first = StaticAssetCacheHeaders.CreateETag("/js/terminal.min.js", fileInfo);
        var second = StaticAssetCacheHeaders.CreateETag("/js/webAudioAccess.js", fileInfo);

        Assert.NotEqual(first, second);
    }

    [Theory]
    [InlineData("/index.html", "public, max-age=0, must-revalidate")]
    [InlineData("/css/app.css", "public, max-age=0, must-revalidate")]
    [InlineData("/js/terminal.min.js", "public, max-age=0, must-revalidate")]
    [InlineData("/site.webmanifest", "public, max-age=0, must-revalidate")]
    [InlineData("/img/logo.png", "public, max-age=86400")]
    public void GetCacheControl_ReturnsExpectedPolicy(string path, string expected)
    {
        Assert.Equal(expected, StaticAssetCacheHeaders.GetCacheControl(path));
    }

    [Theory]
    [InlineData("/fonts/CascadiaCode-Regular.woff2", true)]
    [InlineData("/fonts/midFont.woff", true)]
    [InlineData("/fonts/CascadiaCode-Regular.ttf", true)]
    [InlineData("/img/logo.png", false)]
    public void IsFontAsset_DetectsFontExtensions(string path, bool expected)
    {
        Assert.Equal(expected, StaticAssetCacheHeaders.IsFontAsset(path));
    }

    private sealed class TestFileInfo : IFileInfo
    {
        public TestFileInfo(long length, DateTimeOffset lastModified)
        {
            Length = length;
            LastModified = lastModified;
        }

        public bool Exists => true;
        public long Length { get; }
        public string? PhysicalPath => null;
        public string Name => "test";
        public DateTimeOffset LastModified { get; }
        public bool IsDirectory => false;

        public Stream CreateReadStream()
        {
            return new MemoryStream();
        }
    }
}
