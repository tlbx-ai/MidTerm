using System.Text;
using Ai.Tlbx.MidTerm.Services.WebPreview;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class WebPreviewProxyMiddlewareTests
{
    [Fact]
    public void BuildUpstreamPath_TargetWithBaseAndRootPath_ReturnsTargetBase()
    {
        var target = new Uri("https://example.com/dashboard");

        var result = WebPreviewProxyMiddleware.BuildUpstreamPath(target, "/");

        Assert.Equal("/dashboard", result);
    }

    [Fact]
    public void BuildUpstreamPath_RequestAlreadyContainsTargetBase_DoesNotDuplicate()
    {
        var target = new Uri("https://example.com/dashboard");

        var result = WebPreviewProxyMiddleware.BuildUpstreamPath(target, "/dashboard/lib/sneat/css/core.css");

        Assert.Equal("/dashboard/lib/sneat/css/core.css", result);
    }

    [Fact]
    public void BuildUpstreamPath_RequestOutsideTargetBase_PrependsTargetBase()
    {
        var target = new Uri("https://example.com/dashboard");

        var result = WebPreviewProxyMiddleware.BuildUpstreamPath(target, "/api/health");

        Assert.Equal("/dashboard/api/health", result);
    }

    [Fact]
    public void BuildUpstreamPath_TargetWithoutBasePath_UsesRequestPath()
    {
        var target = new Uri("https://example.com/");

        var result = WebPreviewProxyMiddleware.BuildUpstreamPath(target, "/css/app.css");

        Assert.Equal("/css/app.css", result);
    }

    [Fact]
    public void BuildUpstreamPath_TargetWithTrailingSlashAndRootPath_PreservesTrailingSlash()
    {
        var target = new Uri("https://example.com/dashboard/");

        var result = WebPreviewProxyMiddleware.BuildUpstreamPath(target, "/");

        Assert.Equal("/dashboard/", result);
    }

    [Fact]
    public void RewriteBinaryUrls_Str8_ReplacesAndAdjustsLength()
    {
        var fromUrl = "https://localhost:2000/webpreview";
        var toUrl = "https://webapp.windor.mediathek.aturis.org";
        var fullString = fromUrl + "/kicoach/";
        var fromUtf8 = Encoding.UTF8.GetBytes(fromUrl);
        var toUtf8 = Encoding.UTF8.GetBytes(toUrl);
        var strBytes = Encoding.UTF8.GetBytes(fullString);

        // Build MessagePack str8 frame: [0xd9] [length] [content]
        var frame = new byte[2 + strBytes.Length + 1]; // +1 for trailing byte
        frame[0] = 0xd9;
        frame[1] = (byte)strBytes.Length;
        strBytes.CopyTo(frame, 2);
        frame[^1] = 0x90; // fixarray marker as trailing context

        var result = WebPreviewProxyMiddleware.RewriteBinaryUrls(
            frame, frame.Length, fromUtf8, toUtf8);

        Assert.NotNull(result);

        var expectedString = toUrl + "/kicoach/";
        var expectedBytes = Encoding.UTF8.GetBytes(expectedString);

        // Verify header: str8 with new length
        Assert.Equal(0xd9, result[0]);
        Assert.Equal(expectedBytes.Length, result[1]);

        // Verify content
        var content = Encoding.UTF8.GetString(result, 2, expectedBytes.Length);
        Assert.Equal(expectedString, content);

        // Verify trailing byte preserved
        Assert.Equal(0x90, result[^1]);
    }

    [Fact]
    public void RewriteBinaryUrls_NoMatch_ReturnsNull()
    {
        var data = new byte[] { 0xd9, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f }; // "hello"
        var fromUtf8 = Encoding.UTF8.GetBytes("https://localhost:2000/webpreview");
        var toUtf8 = Encoding.UTF8.GetBytes("https://upstream.example.com");

        var result = WebPreviewProxyMiddleware.RewriteBinaryUrls(
            data, data.Length, fromUtf8, toUtf8);

        Assert.Null(result);
    }

    [Fact]
    public void RewriteBinaryUrls_FixStr_HandlesShortStrings()
    {
        var fromUrl = "http://a.co";
        var toUrl = "http://b.co";
        var fromUtf8 = Encoding.UTF8.GetBytes(fromUrl);
        var toUtf8 = Encoding.UTF8.GetBytes(toUrl);

        // fixstr: [0xa0 | length] [content]
        var frame = new byte[1 + fromUtf8.Length];
        frame[0] = (byte)(0xa0 | fromUtf8.Length);
        fromUtf8.CopyTo(frame, 1);

        var result = WebPreviewProxyMiddleware.RewriteBinaryUrls(
            frame, frame.Length, fromUtf8, toUtf8);

        Assert.NotNull(result);
        Assert.Equal((byte)(0xa0 | toUtf8.Length), result[0]);
        Assert.Equal(toUrl, Encoding.UTF8.GetString(result, 1, toUtf8.Length));
    }

    [Fact]
    public void RewriteBinaryUrls_MultipleOccurrences_RewritesAll()
    {
        var fromUrl = "https://localhost:2000/webpreview";
        var toUrl = "https://upstream.example.com";
        var fromUtf8 = Encoding.UTF8.GetBytes(fromUrl);
        var toUtf8 = Encoding.UTF8.GetBytes(toUrl);

        var str1 = fromUrl + "/kicoach/";
        var str2 = fromUrl + "/kicoach";
        var str1Bytes = Encoding.UTF8.GetBytes(str1);
        var str2Bytes = Encoding.UTF8.GetBytes(str2);

        // Build frame with two str8 strings back-to-back
        var frame = new byte[2 + str1Bytes.Length + 2 + str2Bytes.Length];
        var offset = 0;
        frame[offset++] = 0xd9;
        frame[offset++] = (byte)str1Bytes.Length;
        str1Bytes.CopyTo(frame, offset);
        offset += str1Bytes.Length;
        frame[offset++] = 0xd9;
        frame[offset++] = (byte)str2Bytes.Length;
        str2Bytes.CopyTo(frame, offset);

        var result = WebPreviewProxyMiddleware.RewriteBinaryUrls(
            frame, frame.Length, fromUtf8, toUtf8);

        Assert.NotNull(result);

        var expected1 = toUrl + "/kicoach/";
        var expected2 = toUrl + "/kicoach";
        var resultStr = Encoding.UTF8.GetString(result);
        Assert.Contains(expected1, resultStr);
        Assert.Contains(expected2, resultStr);
    }

    [Fact]
    public void RewriteBinaryUrls_NoValidHeader_PassesThrough()
    {
        // URL bytes appear in binary data but NOT preceded by a valid MsgPack string header
        var fromUrl = "http://a.co";
        var toUrl = "http://b.co";
        var fromUtf8 = Encoding.UTF8.GetBytes(fromUrl);
        var toUtf8 = Encoding.UTF8.GetBytes(toUrl);

        // Just raw bytes with no MsgPack header (preceding byte 0x05 is a positive fixint, not a str header)
        var frame = new byte[1 + fromUtf8.Length];
        frame[0] = 0x05;
        fromUtf8.CopyTo(frame, 1);

        var result = WebPreviewProxyMiddleware.RewriteBinaryUrls(
            frame, frame.Length, fromUtf8, toUtf8);

        Assert.Null(result); // No valid header → null → caller forwards original
    }

    [Fact]
    public void RewriteBinaryUrls_StringExtendsPastBuffer_ReturnsNull()
    {
        var fromUrl = "http://a.co";
        var toUrl = "http://b.co";
        var fromUtf8 = Encoding.UTF8.GetBytes(fromUrl);
        var toUtf8 = Encoding.UTF8.GetBytes(toUrl);

        // str8 header claims string is 200 bytes, but buffer is only header + fromUrl
        var frame = new byte[2 + fromUtf8.Length];
        frame[0] = 0xd9;
        frame[1] = 200; // Claimed length far exceeds actual data
        fromUtf8.CopyTo(frame, 2);

        var result = WebPreviewProxyMiddleware.RewriteBinaryUrls(
            frame, frame.Length, fromUtf8, toUtf8);

        Assert.Null(result); // Corrupt data → bail → caller forwards original
    }

    [Fact]
    public void RewriteBinaryUrls_SurroundingDataPreserved()
    {
        var fromUrl = "http://a.co";
        var toUrl = "http://longer.example.com";
        var fromUtf8 = Encoding.UTF8.GetBytes(fromUrl);
        var toUtf8 = Encoding.UTF8.GetBytes(toUrl);

        // Build: [prefix bytes] [str8 header] [url] [suffix bytes]
        var prefix = new byte[] { 0x93, 0x80, 0x01 }; // fixarray(3), fixmap(0), fixint(1)
        var suffix = new byte[] { 0xc0, 0x90 };        // nil, fixarray(0)

        var frame = new byte[prefix.Length + 2 + fromUtf8.Length + suffix.Length];
        prefix.CopyTo(frame, 0);
        frame[prefix.Length] = 0xd9;
        frame[prefix.Length + 1] = (byte)fromUtf8.Length;
        fromUtf8.CopyTo(frame, prefix.Length + 2);
        suffix.CopyTo(frame, prefix.Length + 2 + fromUtf8.Length);

        var result = WebPreviewProxyMiddleware.RewriteBinaryUrls(
            frame, frame.Length, fromUtf8, toUtf8);

        Assert.NotNull(result);

        // Prefix preserved
        Assert.Equal(prefix[0], result[0]);
        Assert.Equal(prefix[1], result[1]);
        Assert.Equal(prefix[2], result[2]);

        // Suffix preserved at end
        Assert.Equal(suffix[0], result[^2]);
        Assert.Equal(suffix[1], result[^1]);

        // Rewriter uses most compact header: 25 bytes fits in fixstr (1 byte header)
        Assert.Equal((byte)(0xa0 | toUtf8.Length), result[prefix.Length]);
        var strStart = prefix.Length + 1; // fixstr header is 1 byte
        Assert.Equal(toUrl, Encoding.UTF8.GetString(result, strStart, toUtf8.Length));
    }

    [Fact]
    public void RewriteBinaryUrls_PartialBufferLength_OnlyReadsWithinLength()
    {
        var fromUrl = "http://a.co";
        var toUrl = "http://b.co";
        var fromUtf8 = Encoding.UTF8.GetBytes(fromUrl);
        var toUtf8 = Encoding.UTF8.GetBytes(toUrl);

        // Frame has the URL but length parameter cuts it short
        var frame = new byte[2 + fromUtf8.Length + 10];
        frame[0] = 0xd9;
        frame[1] = (byte)fromUtf8.Length;
        fromUtf8.CopyTo(frame, 2);

        // Only pass length that covers half the URL — should not match
        var result = WebPreviewProxyMiddleware.RewriteBinaryUrls(
            frame, fromUtf8.Length / 2, fromUtf8, toUtf8);

        Assert.Null(result);
    }
}
