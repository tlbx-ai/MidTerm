using System.Collections.Frozen;
using System.Text;

namespace Ai.Tlbx.MidTerm.Services.Tmux;

/// <summary>
/// Translates tmux key names to terminal byte sequences.
/// Used by send-keys to convert named keys like "Enter", "Escape", "C-a" to actual bytes.
/// </summary>
public static class TmuxKeyTranslator
{
    private static readonly FrozenDictionary<string, byte[]> NamedKeys = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase)
    {
        ["Enter"] = "\r"u8.ToArray(),
        ["Return"] = "\r"u8.ToArray(),
        ["Escape"] = "\x1b"u8.ToArray(),
        ["Tab"] = "\t"u8.ToArray(),
        ["Space"] = " "u8.ToArray(),
        ["BSpace"] = "\x7f"u8.ToArray(),
        ["Delete"] = "\x1b[3~"u8.ToArray(),
        ["Insert"] = "\x1b[2~"u8.ToArray(),
        ["Up"] = "\x1b[A"u8.ToArray(),
        ["Down"] = "\x1b[B"u8.ToArray(),
        ["Right"] = "\x1b[C"u8.ToArray(),
        ["Left"] = "\x1b[D"u8.ToArray(),
        ["Home"] = "\x1b[H"u8.ToArray(),
        ["End"] = "\x1b[F"u8.ToArray(),
        ["PageUp"] = "\x1b[5~"u8.ToArray(),
        ["PgUp"] = "\x1b[5~"u8.ToArray(),
        ["PageDown"] = "\x1b[6~"u8.ToArray(),
        ["PgDn"] = "\x1b[6~"u8.ToArray(),
        ["F1"] = "\x1bOP"u8.ToArray(),
        ["F2"] = "\x1bOQ"u8.ToArray(),
        ["F3"] = "\x1bOR"u8.ToArray(),
        ["F4"] = "\x1bOS"u8.ToArray(),
        ["F5"] = "\x1b[15~"u8.ToArray(),
        ["F6"] = "\x1b[17~"u8.ToArray(),
        ["F7"] = "\x1b[18~"u8.ToArray(),
        ["F8"] = "\x1b[19~"u8.ToArray(),
        ["F9"] = "\x1b[20~"u8.ToArray(),
        ["F10"] = "\x1b[21~"u8.ToArray(),
        ["F11"] = "\x1b[23~"u8.ToArray(),
        ["F12"] = "\x1b[24~"u8.ToArray(),
        ["BTab"] = "\x1b[Z"u8.ToArray(),
        ["DC"] = "\x1b[3~"u8.ToArray(),
        ["IC"] = "\x1b[2~"u8.ToArray(),
        ["NPage"] = "\x1b[6~"u8.ToArray(),
        ["PPage"] = "\x1b[5~"u8.ToArray(),
    }.ToFrozenDictionary(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Translate a single tmux key argument to bytes.
    /// Handles named keys (Enter, Escape, Up, etc.), control keys (C-a), and literal text.
    /// </summary>
    public static byte[] TranslateKey(string key)
    {
        if (NamedKeys.TryGetValue(key, out var sequence))
        {
            return sequence;
        }

        // Control key: C-a through C-z
        if (key.Length == 3 && key.StartsWith("C-", StringComparison.OrdinalIgnoreCase))
        {
            var ch = char.ToLowerInvariant(key[2]);
            if (ch is >= 'a' and <= 'z')
            {
                return [(byte)(ch - 'a' + 1)];
            }
        }

        // Meta key: M-x → ESC + x
        if (key.Length >= 3 && key.StartsWith("M-", StringComparison.OrdinalIgnoreCase))
        {
            var rest = key[2..];
            var restBytes = Encoding.UTF8.GetBytes(rest);
            var result = new byte[1 + restBytes.Length];
            result[0] = 0x1b;
            restBytes.CopyTo(result, 1);
            return result;
        }

        // Literal text
        return Encoding.UTF8.GetBytes(key);
    }

    /// <summary>
    /// Translate all key arguments into a single byte sequence.
    /// </summary>
    public static byte[] TranslateKeys(IReadOnlyList<string> keys, bool literal)
    {
        if (literal)
        {
            return Encoding.UTF8.GetBytes(string.Join("", keys));
        }

        if (keys.Count == 1)
        {
            return TranslateKey(keys[0]);
        }

        using var ms = new MemoryStream();
        foreach (var key in keys)
        {
            ms.Write(TranslateKey(key));
        }
        return ms.ToArray();
    }
}
