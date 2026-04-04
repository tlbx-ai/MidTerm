using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.FileProviders;

namespace Ai.Tlbx.MidTerm.Services.StaticFiles;

internal static class StaticAssetCacheHeaders
{
    private static readonly Regex AssetVersionQueryRegex =
        new(@"\?v=[^""'\s>]+", RegexOptions.Compiled | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

    public static string CreateETag(string requestPath, IFileInfo fileInfo)
    {
        var normalizedPath = requestPath.Replace('\\', '/').Trim();
        if (!normalizedPath.StartsWith("/", StringComparison.Ordinal))
        {
            normalizedPath = "/" + normalizedPath;
        }

        var material = string.Create(CultureInfo.InvariantCulture, $"{normalizedPath}|{fileInfo.Length}|{fileInfo.LastModified.ToUniversalTime().Ticks}");
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(material));
        return $"\"{Convert.ToHexString(hash.AsSpan(0, 8))}\"";
    }

    public static bool IsFontAsset(string requestPath)
    {
        return requestPath.EndsWith(".woff2", StringComparison.OrdinalIgnoreCase)
               || requestPath.EndsWith(".woff", StringComparison.OrdinalIgnoreCase)
               || requestPath.EndsWith(".ttf", StringComparison.OrdinalIgnoreCase);
    }

    public static string GetCacheControl(string requestPath)
    {
        return IsEntryPointAsset(requestPath)
            ? "public, max-age=0, must-revalidate"
            : "public, max-age=86400";
    }

    public static bool IsHtmlEntryPoint(string requestPath)
    {
        return requestPath.EndsWith(".html", StringComparison.OrdinalIgnoreCase);
    }

    public static string StampHtmlAssetUrls(string html, string assetVersion)
    {
        if (string.IsNullOrWhiteSpace(html) || string.IsNullOrWhiteSpace(assetVersion))
        {
            return html;
        }

        return AssetVersionQueryRegex.Replace(html, $"?v={assetVersion}");
    }

    private static bool IsEntryPointAsset(string requestPath)
    {
        return requestPath.EndsWith(".html", StringComparison.OrdinalIgnoreCase)
               || requestPath.EndsWith(".css", StringComparison.OrdinalIgnoreCase)
               || requestPath.EndsWith(".js", StringComparison.OrdinalIgnoreCase)
               || requestPath.EndsWith(".webmanifest", StringComparison.OrdinalIgnoreCase);
    }
}
