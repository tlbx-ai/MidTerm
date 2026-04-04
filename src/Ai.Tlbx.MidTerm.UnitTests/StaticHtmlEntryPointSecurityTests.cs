using System.Text.RegularExpressions;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class StaticHtmlEntryPointSecurityTests
{
    private static readonly Regex InlineScriptTagRegex =
        new(@"<script(?![^>]*\bsrc=)[^>]*>", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

    [Theory]
    [InlineData("index.html")]
    [InlineData("login.html")]
    [InlineData("trust.html")]
    [InlineData("web-preview-popup.html")]
    public void StaticEntryPoint_DoesNotContainInlineScriptTags(string relativePath)
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        var htmlPath = Path.Combine(repoRoot, "src", "Ai.Tlbx.MidTerm", "src", "static", relativePath);
        var html = File.ReadAllText(htmlPath);

        Assert.DoesNotMatch(InlineScriptTagRegex, html);
    }
}
