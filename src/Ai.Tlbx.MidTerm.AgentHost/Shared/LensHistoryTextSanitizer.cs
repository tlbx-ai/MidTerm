using System.Text;
using System.Text.RegularExpressions;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

internal static partial class LensHistoryTextSanitizer
{
    [GeneratedRegex(@"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])", RegexOptions.NonBacktracking, 1000)]
    private static partial Regex AnsiEscapeRegex();

    public static string Sanitize(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        var normalized = AnsiEscapeRegex()
            .Replace(value, string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n');

        var builder = new StringBuilder(normalized.Length);
        foreach (var character in normalized)
        {
            if (character == '\n' || character == '\t' || !char.IsControl(character))
            {
                builder.Append(character);
            }
        }

        return builder.ToString().Trim();
    }

    public static string JoinDistinctSections(params string?[] sections)
    {
        List<string>? parts = null;
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var section in sections)
        {
            var sanitized = Sanitize(section);
            if (string.IsNullOrWhiteSpace(sanitized) || !seen.Add(sanitized))
            {
                continue;
            }

            parts ??= [];
            parts.Add(sanitized);
        }

        return parts is null ? string.Empty : string.Join("\n\n", parts);
    }
}
