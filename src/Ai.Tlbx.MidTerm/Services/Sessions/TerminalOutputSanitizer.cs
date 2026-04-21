using System.Text;
using System.Text.RegularExpressions;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public static partial class TerminalOutputSanitizer
{
    [GeneratedRegex(@"\x1B(?:\][^\x07]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|\([AB012]|[@-Z\\-_])", RegexOptions.None, 1000)]
    private static partial Regex AnsiEscapePattern();

    public static string Decode(ReadOnlySpan<byte> buffer)
    {
        return Encoding.UTF8.GetString(buffer);
    }

    public static string StripEscapeSequences(string text)
    {
        var withoutEscapes = AnsiEscapePattern().Replace(text, "");
        var sb = new StringBuilder(withoutEscapes.Length);
        var currentLineStart = 0;

        for (var i = 0; i < withoutEscapes.Length; i++)
        {
            var c = withoutEscapes[i];

            if (c == '\r')
            {
                if (i + 1 < withoutEscapes.Length && withoutEscapes[i + 1] == '\n')
                {
                    sb.Append('\n');
                    currentLineStart = sb.Length;
                    i++;
                }
                else
                {
                    sb.Length = currentLineStart;
                }

                continue;
            }

            if (c == '\n')
            {
                sb.Append(c);
                currentLineStart = sb.Length;
                continue;
            }

            if (c == '\t')
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
        var normalized = CollapseBlankLineRuns(NormalizeLineEndings(text), maxBlankLines: 1)
            .Trim('\n');
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

    private static string CollapseBlankLineRuns(string text, int maxBlankLines)
    {
        if (string.IsNullOrEmpty(text))
        {
            return text;
        }

        maxBlankLines = Math.Max(0, maxBlankLines);
        var lines = text.Split('\n');
        var sb = new StringBuilder(text.Length);
        var blankRun = 0;

        foreach (var line in lines)
        {
            var isBlank = string.IsNullOrWhiteSpace(line);
            if (isBlank)
            {
                blankRun++;
                if (blankRun > maxBlankLines)
                {
                    continue;
                }
            }
            else
            {
                blankRun = 0;
            }

            if (sb.Length > 0)
            {
                sb.Append('\n');
            }

            sb.Append(line);
        }

        return sb.ToString();
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

    public static int CountVisibleTextUnits(ReadOnlySpan<byte> data)
    {
        var count = 0;
        var inOsc = false;

        for (var i = 0; i < data.Length;)
        {
            var current = data[i];

            if (inOsc)
            {
                if (current == 0x07)
                {
                    inOsc = false;
                    i++;
                    continue;
                }

                if (current == 0x1B &&
                    i + 1 < data.Length &&
                    data[i + 1] == 0x5C)
                {
                    inOsc = false;
                    i += 2;
                    continue;
                }

                i++;
                continue;
            }

            if (current == 0x1B)
            {
                if (i + 1 >= data.Length)
                {
                    break;
                }

                var next = data[i + 1];
                if (next == 0x5D)
                {
                    inOsc = true;
                    i += 2;
                    continue;
                }

                if (next == 0x5B)
                {
                    i = SkipCsiSequence(data, i + 2);
                    continue;
                }

                if (next == 0x28 &&
                    i + 2 < data.Length &&
                    data[i + 2] is (byte)'A' or (byte)'B' or (byte)'0' or (byte)'1' or (byte)'2')
                {
                    i += 3;
                    continue;
                }

                i += 2;
                continue;
            }

            if (current is (byte)'\n' or (byte)'\t')
            {
                count++;
                i++;
                continue;
            }

            if (current >= 0x20 && current != 0x7F)
            {
                if (current < 0x80)
                {
                    count++;
                    i++;
                    continue;
                }

                var runeLength = GetUtf8RuneLength(current);
                if (i + runeLength > data.Length)
                {
                    break;
                }

                count++;
                i += runeLength;
                continue;
            }

            i++;
        }

        return count;
    }

    private static int SkipCsiSequence(ReadOnlySpan<byte> data, int start)
    {
        var i = start;
        while (i < data.Length)
        {
            var current = data[i];
            if (current >= 0x40 && current <= 0x7E)
            {
                return i + 1;
            }

            i++;
        }

        return data.Length;
    }

    private static int GetUtf8RuneLength(byte firstByte)
    {
        if ((firstByte & 0b1110_0000) == 0b1100_0000)
        {
            return 2;
        }

        if ((firstByte & 0b1111_0000) == 0b1110_0000)
        {
            return 3;
        }

        if ((firstByte & 0b1111_1000) == 0b1111_0000)
        {
            return 4;
        }

        return 1;
    }
}
