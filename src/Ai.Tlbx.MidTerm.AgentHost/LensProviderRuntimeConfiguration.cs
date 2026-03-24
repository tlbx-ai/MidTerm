using System.Diagnostics;

namespace Ai.Tlbx.MidTerm.AgentHost;

internal static class LensProviderRuntimeConfiguration
{
    private const string CodexEnvironmentVariablesEnvironmentVariable = "MIDTERM_LENS_CODEX_ENVIRONMENT_VARIABLES";
    private const string ClaudeEnvironmentVariablesEnvironmentVariable = "MIDTERM_LENS_CLAUDE_ENVIRONMENT_VARIABLES";
    private const string ClaudeDangerouslySkipPermissionsEnvironmentVariable = "MIDTERM_LENS_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS";

    public static void ApplyEnvironmentVariables(ProcessStartInfo startInfo, string provider)
    {
        ArgumentNullException.ThrowIfNull(startInfo);

        foreach (var pair in ReadEnvironmentVariables(provider))
        {
            startInfo.Environment[pair.Key] = pair.Value;
        }
    }

    public static bool GetClaudeDangerouslySkipPermissionsDefault()
    {
        return bool.TryParse(
                   Environment.GetEnvironmentVariable(ClaudeDangerouslySkipPermissionsEnvironmentVariable),
                   out var enabled) &&
               enabled;
    }

    private static IReadOnlyDictionary<string, string> ReadEnvironmentVariables(string provider)
    {
        var raw = provider switch
        {
            "codex" => Environment.GetEnvironmentVariable(CodexEnvironmentVariablesEnvironmentVariable),
            "claude" => Environment.GetEnvironmentVariable(ClaudeEnvironmentVariablesEnvironmentVariable),
            _ => null
        };

        if (string.IsNullOrWhiteSpace(raw))
        {
            return Empty;
        }

        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var rawLine in raw.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!IsValidEnvironmentVariableLine(rawLine))
            {
                continue;
            }

            var separator = rawLine.IndexOf('=');
            var key = rawLine[..separator];
            var value = rawLine[(separator + 1)..];
            result[key] = value;
        }

        return result;
    }

    private static bool IsValidEnvironmentVariableLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return false;
        }

        var separator = line.IndexOf('=');
        if (separator <= 0)
        {
            return false;
        }

        var key = line[..separator];
        if (!(char.IsLetter(key[0]) || key[0] == '_'))
        {
            return false;
        }

        for (var i = 1; i < key.Length; i++)
        {
            var ch = key[i];
            if (!(char.IsLetterOrDigit(ch) || ch == '_'))
            {
                return false;
            }
        }

        return true;
    }

    private static IReadOnlyDictionary<string, string> Empty { get; } = new Dictionary<string, string>(0, StringComparer.Ordinal);
}
