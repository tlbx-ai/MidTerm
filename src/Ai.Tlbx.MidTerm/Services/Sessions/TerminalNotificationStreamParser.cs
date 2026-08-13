using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

/// <summary>
/// Incrementally recognizes terminal notification protocols in raw PTY output.
/// Supports BEL, OSC 9, OSC 777, C1 OSC/ST, ST/BEL terminators, fragmented
/// sequences, and the doubled ESC used by tmux passthrough.
/// </summary>
public sealed class TerminalNotificationStreamParser
{
    private const int MaxOscPayloadBytes = 4096;
    private const int MaxTitleTextElements = 80;
    private const int MaxBodyTextElements = 240;

    private enum ParseState
    {
        Ground,
        Escape,
        Osc,
        OscEscape,
        DiscardOsc,
        DiscardOscEscape
    }

    private readonly List<byte> _oscPayload = new(MaxOscPayloadBytes);
    private ParseState _state;
    private int _utf8ContinuationBytesRemaining;

    public IReadOnlyList<TerminalNotificationMessage> Parse(string sessionId, ReadOnlySpan<byte> data)
    {
        List<TerminalNotificationMessage>? notifications = null;

        foreach (var current in data)
        {
            switch (_state)
            {
                case ParseState.Ground:
                    if (current == 0x07)
                    {
                        (notifications ??= []).Add(CreateMessage(sessionId, "bel"));
                    }
                    else if (current == 0x1B)
                    {
                        _state = ParseState.Escape;
                    }
                    else if (current == 0x9D)
                    {
                        BeginOsc();
                    }
                    break;

                case ParseState.Escape:
                    if (current == (byte)']')
                    {
                        BeginOsc();
                    }
                    else if (current != 0x1B)
                    {
                        _state = ParseState.Ground;
                    }
                    // Consecutive ESC bytes retain Escape. This recognizes the
                    // ESC ESC ] introducer emitted by tmux passthrough.
                    break;

                case ParseState.Osc:
                    if (TryAppendUtf8Continuation(current))
                    {
                        break;
                    }

                    if (current == 0x07 || current == 0x9C)
                    {
                        AddOscNotification(sessionId, ref notifications);
                    }
                    else if (current is 0x18 or 0x1A)
                    {
                        Reset();
                    }
                    else if (current == 0x1B)
                    {
                        _state = ParseState.OscEscape;
                    }
                    else
                    {
                        AppendOscByte(current);
                    }
                    break;

                case ParseState.OscEscape:
                    if (current == (byte)'\\')
                    {
                        AddOscNotification(sessionId, ref notifications);
                    }
                    else if (current == 0x1B)
                    {
                        AppendOscByte(0x1B);
                    }
                    else
                    {
                        AppendOscByte(0x1B);
                        AppendOscByte(current);
                        if (_state != ParseState.DiscardOsc)
                        {
                            _state = ParseState.Osc;
                        }
                    }
                    break;

                case ParseState.DiscardOsc:
                    if (current is 0x07 or 0x9C or 0x18 or 0x1A)
                    {
                        Reset();
                    }
                    else if (current == 0x1B)
                    {
                        _state = ParseState.DiscardOscEscape;
                    }
                    break;

                case ParseState.DiscardOscEscape:
                    if (current == (byte)'\\')
                    {
                        Reset();
                    }
                    else if (current != 0x1B)
                    {
                        _state = ParseState.DiscardOsc;
                    }
                    break;
            }
        }

        return notifications ?? [];
    }

    public void Reset()
    {
        _oscPayload.Clear();
        _state = ParseState.Ground;
        _utf8ContinuationBytesRemaining = 0;
    }

    public static TerminalNotificationMessage? CreateAdHocNotification(
        string sessionId,
        string? title,
        string body,
        NotificationPrioritySetting? priority = null)
    {
        var normalizedTitle = NormalizeText(title ?? "", MaxTitleTextElements);
        var normalizedBody = NormalizeText(body, MaxBodyTextElements);
        if (normalizedBody is null)
        {
            return null;
        }

        return new TerminalNotificationMessage
        {
            SessionId = sessionId,
            Protocol = "cli",
            Title = normalizedTitle,
            Body = normalizedBody,
            Force = true,
            Priority = priority
        };
    }

    private void BeginOsc()
    {
        _oscPayload.Clear();
        _state = ParseState.Osc;
        _utf8ContinuationBytesRemaining = 0;
    }

    private void AppendOscByte(byte value)
    {
        if (_oscPayload.Count >= MaxOscPayloadBytes)
        {
            _oscPayload.Clear();
            _state = ParseState.DiscardOsc;
            return;
        }

        _oscPayload.Add(value);
        _utf8ContinuationBytesRemaining = value switch
        {
            >= 0xC2 and <= 0xDF => 1,
            >= 0xE0 and <= 0xEF => 2,
            >= 0xF0 and <= 0xF4 => 3,
            _ => _utf8ContinuationBytesRemaining
        };
    }

    private bool TryAppendUtf8Continuation(byte value)
    {
        if (_utf8ContinuationBytesRemaining == 0)
        {
            return false;
        }

        if (value is < 0x80 or > 0xBF)
        {
            _utf8ContinuationBytesRemaining = 0;
            return false;
        }

        if (_oscPayload.Count >= MaxOscPayloadBytes)
        {
            _oscPayload.Clear();
            _utf8ContinuationBytesRemaining = 0;
            _state = ParseState.DiscardOsc;
            return true;
        }

        _oscPayload.Add(value);
        _utf8ContinuationBytesRemaining--;
        return true;
    }

    private void AddOscNotification(
        string sessionId,
        ref List<TerminalNotificationMessage>? notifications)
    {
        var message = ParseOscPayload(sessionId, _oscPayload);
        Reset();
        if (message is not null)
        {
            (notifications ??= []).Add(message);
        }
    }

    private static TerminalNotificationMessage? ParseOscPayload(
        string sessionId,
        List<byte> payloadBytes)
    {
        var payload = Encoding.UTF8.GetString(CollectionsMarshal.AsSpan(payloadBytes));
        var separator = payload.IndexOf(';', StringComparison.Ordinal);
        if (separator < 0)
        {
            return null;
        }

        var command = payload[..separator];
        var arguments = payload[(separator + 1)..];
        if (command == "9")
        {
            var numericSeparator = arguments.IndexOf(';', StringComparison.Ordinal);
            if (numericSeparator > 0 &&
                arguments.AsSpan(0, numericSeparator).IndexOfAnyExceptInRange('0', '9') < 0)
            {
                return null;
            }

            var body = NormalizeText(arguments, MaxBodyTextElements);
            return body is null ? null : CreateMessage(sessionId, "osc9", body: body);
        }

        if (command != "777" || !arguments.StartsWith("notify;", StringComparison.Ordinal))
        {
            return null;
        }

        var content = arguments["notify;".Length..];
        var titleSeparator = content.IndexOf(';', StringComparison.Ordinal);
        if (titleSeparator < 0)
        {
            return null;
        }

        var title = NormalizeText(content[..titleSeparator], MaxTitleTextElements);
        var body777 = NormalizeText(content[(titleSeparator + 1)..], MaxBodyTextElements);
        return title is null && body777 is null
            ? null
            : CreateMessage(sessionId, "osc777", title, body777);
    }

    private static string? NormalizeText(string value, int limit)
    {
        value = StripTerminalEscapeSequences(value);
        var builder = new StringBuilder(value.Length);
        var pendingSpace = false;

        foreach (var character in value)
        {
            if (char.IsWhiteSpace(character) || char.IsControl(character) || IsBidiControl(character))
            {
                pendingSpace = builder.Length > 0;
                continue;
            }

            if (pendingSpace)
            {
                builder.Append(' ');
                pendingSpace = false;
            }
            builder.Append(character);
        }

        var normalized = builder.ToString().Trim();
        if (normalized.Length == 0)
        {
            return null;
        }

        var textElements = StringInfo.ParseCombiningCharacters(normalized);
        if (textElements.Length <= limit)
        {
            return normalized;
        }

        return normalized[..textElements[limit - 1]] + "…";
    }

    private static bool IsBidiControl(char value) =>
        value is >= '\u202A' and <= '\u202E' or >= '\u2066' and <= '\u2069';

    private static string StripTerminalEscapeSequences(string value)
    {
        var builder = new StringBuilder(value.Length);
        for (var index = 0; index < value.Length; index++)
        {
            if (value[index] != '\x1B')
            {
                builder.Append(value[index]);
                continue;
            }

            if (index + 1 >= value.Length)
            {
                break;
            }

            var introducer = value[++index];
            if (introducer == '[')
            {
                while (++index < value.Length && value[index] is < '@' or > '~')
                {
                }
            }
            else if (introducer == ']')
            {
                while (++index < value.Length)
                {
                    if (value[index] == '\a')
                    {
                        break;
                    }

                    if (value[index] == '\x1B' && index + 1 < value.Length && value[index + 1] == '\\')
                    {
                        index++;
                        break;
                    }
                }
            }
        }

        return builder.ToString();
    }

    private static TerminalNotificationMessage CreateMessage(
        string sessionId,
        string protocol,
        string? title = null,
        string? body = null) => new()
        {
            SessionId = sessionId,
            Protocol = protocol,
            Title = title,
            Body = body
        };
}
