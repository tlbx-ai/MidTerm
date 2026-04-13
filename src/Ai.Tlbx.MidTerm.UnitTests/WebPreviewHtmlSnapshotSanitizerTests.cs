using Ai.Tlbx.MidTerm.Services.WebPreview;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class WebPreviewHtmlSnapshotSanitizerTests
{
    [Fact]
    public void StripProxyArtifacts_RemovesInjectedBaseProxyAndBlobScripts()
    {
        const string html = """
            <html>
              <head>
                <base href="/webpreview/route-1/">
                <script>(function(){window.__mtProxy={};})();</script>
                <script src="blob:https://midterm.local/123"></script>
              </head>
              <body><main>hello</main></body>
            </html>
            """;

        var sanitized = WebPreviewHtmlSnapshotSanitizer.StripProxyArtifacts(html);

        Assert.DoesNotContain("<base", sanitized, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("window.__mtProxy", sanitized, StringComparison.Ordinal);
        Assert.DoesNotContain("blob:https://midterm.local/123", sanitized, StringComparison.Ordinal);
        Assert.Contains("<main>hello</main>", sanitized, StringComparison.Ordinal);
    }

    [Fact]
    public void DecodeExtUrls_ReplacesEncodedExternalProxyUrls()
    {
        const string html = """
            <img src="/_ext?u=https%3A%2F%2Fexample.com%2Fimg%2Flogo.svg">
            <a href="/_ext?u=https%3A%2F%2Fexample.com%2Fdocs%3Fa%3D1">Docs</a>
            """;

        var sanitized = WebPreviewHtmlSnapshotSanitizer.DecodeExtUrls(html);

        Assert.Contains("https://example.com/img/logo.svg", sanitized, StringComparison.Ordinal);
        Assert.Contains("https://example.com/docs?a=1", sanitized, StringComparison.Ordinal);
        Assert.DoesNotContain("/_ext?u=", sanitized, StringComparison.Ordinal);
    }
}
