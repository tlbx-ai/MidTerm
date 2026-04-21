using System.Collections.ObjectModel;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

internal static class TerminalEnvironmentVariableParser
{
    public static IReadOnlyDictionary<string, string?>? Parse(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        Dictionary<string, string?>? result = null;
        using var reader = new StringReader(value);

        while (reader.ReadLine() is { } line)
        {
            if (!TryParseLine(line, out var key, out var parsedValue))
            {
                continue;
            }

            result ??= new Dictionary<string, string?>(StringComparer.Ordinal);
            result[key] = parsedValue;
        }

        return result is null ? null : new ReadOnlyDictionary<string, string?>(result);
    }

    private static bool TryParseLine(string line, out string key, out string value)
    {
        key = string.Empty;
        value = string.Empty;

        if (string.IsNullOrWhiteSpace(line))
        {
            return false;
        }

        var separatorIndex = line.IndexOf('=', StringComparison.Ordinal);
        if (separatorIndex <= 0)
        {
            return false;
        }

        var candidateKey = line[..separatorIndex].Trim();
        if (!IsValidEnvironmentVariableName(candidateKey) ||
            candidateKey.StartsWith("MIDTERM_", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        key = candidateKey;
        value = line[(separatorIndex + 1)..];
        return true;
    }

    private static bool IsValidEnvironmentVariableName(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return false;
        }

        if (!(char.IsAsciiLetter(value[0]) || value[0] == '_'))
        {
            return false;
        }

        foreach (var character in value.AsSpan(1))
        {
            if (!(char.IsAsciiLetterOrDigit(character) || character == '_'))
            {
                return false;
            }
        }

        return true;
    }
}
