namespace Ai.Tlbx.MidTerm.Common.Shells;

public static class TerminalEnvironmentOverrides
{
    public const string OverrideKeysEnvironmentVariable = "MIDTERM_TERMINAL_ENVIRONMENT_OVERRIDE_KEYS";

    public static string SerializeOverrideKeys(IEnumerable<string> keys)
    {
        return string.Join(
            '\n',
            keys
                .Where(IsUserOverrideKey)
                .Distinct(StringComparer.Ordinal));
    }

    public static void ApplyMarkedOverrides(IDictionary<string, string> environment)
    {
        var serializedKeys = Environment.GetEnvironmentVariable(OverrideKeysEnvironmentVariable);
        ApplyMarkedOverrides(
            environment,
            serializedKeys,
            Environment.GetEnvironmentVariable);
    }

    internal static void ApplyMarkedOverrides(
        IDictionary<string, string> environment,
        string? serializedKeys,
        Func<string, string?> getValue)
    {
        environment.Remove(OverrideKeysEnvironmentVariable);

        if (string.IsNullOrWhiteSpace(serializedKeys))
        {
            return;
        }

        using var reader = new StringReader(serializedKeys);
        while (reader.ReadLine() is { } key)
        {
            if (!IsUserOverrideKey(key))
            {
                continue;
            }

            var value = getValue(key);
            if (value is null)
            {
                environment.Remove(key);
            }
            else
            {
                environment[key] = value;
            }
        }
    }

    private static bool IsUserOverrideKey(string value)
    {
        if (string.IsNullOrWhiteSpace(value) ||
            string.Equals(value, OverrideKeysEnvironmentVariable, StringComparison.Ordinal) ||
            value.StartsWith("MIDTERM_", StringComparison.OrdinalIgnoreCase))
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
