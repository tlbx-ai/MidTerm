using System.Text;
using System.Text.RegularExpressions;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public static partial class TerminalOutputSanitizer
{
    [GeneratedRegex(@"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|\([AB012])")]
    private static partial Regex AnsiEscapePattern();

    public static string Decode(ReadOnlySpan<byte> buffer)
    {
        return Encoding.UTF8.GetString(buffer);
    }

    public static string StripEscapeSequences(string text)
    {
        var withoutEscapes = AnsiEscapePattern().Replace(text, "");
        var sb = new StringBuilder(withoutEscapes.Length);

        foreach (var c in withoutEscapes)
        {
            if (c is '\n' or '\r' or '\t')
            {
                sb.Append(c);
                continue;
            }

            if (!char.IsControl(c))
            {
                sb.Append(c);
            }
        }

        return sb.ToString();
    }

    public static string NormalizeLineEndings(string text)
    {
        return text.Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n');
    }

    public static string TailLines(string text, int maxLines, out int totalLines, out int returnedLines)
    {
        var normalized = NormalizeLineEndings(text);
        var lines = normalized.Split('\n');

        totalLines = lines.Length;

        if (maxLines <= 0)
        {
            maxLines = 1;
        }

        var start = Math.Max(0, lines.Length - maxLines);
        returnedLines = lines.Length - start;
        return string.Join('\n', lines[start..]);
    }

    public static int CountBellEvents(ReadOnlySpan<byte> data)
    {
        var count = 0;
        var inOsc = false;

        for (var i = 0; i < data.Length; i++)
        {
            var current = data[i];

            if (!inOsc &&
                current == 0x1B &&
                i + 1 < data.Length &&
                data[i + 1] == 0x5D)
            {
                inOsc = true;
                i++;
                continue;
            }

            if (inOsc)
            {
                if (current == 0x07)
                {
                    inOsc = false;
                    continue;
                }

                if (current == 0x1B &&
                    i + 1 < data.Length &&
                    data[i + 1] == 0x5C)
                {
                    inOsc = false;
                    i++;
                }

                continue;
            }

            if (current == 0x07)
            {
                count++;
            }
        }

        return count;
    }
}
