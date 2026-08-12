using System.Buffers.Text;
using System.Runtime.InteropServices;

namespace Ai.Tlbx.MidTerm.TtyHost;

/// <summary>
/// Prevents delayed or replayed browser answers to terminal color queries from
/// reaching an application after it has already stopped waiting for them.
/// </summary>
internal sealed class TerminalColorQueryGuard(TimeProvider? timeProvider = null)
{
    private static readonly TimeSpan MaximumResponseAge = TimeSpan.FromSeconds(1);
    private const int MaximumOscBytes = 1024;
    private const byte Escape = 0x1b;
    private const byte Bell = 0x07;

    private readonly TimeProvider _timeProvider = timeProvider ?? TimeProvider.System;
    private readonly Lock _lock = new();
    private readonly Dictionary<int, PendingQuery> _queries = [];
    private readonly List<byte> _osc = new(64);
    private bool _capturingOsc;
    private bool _oscEscapePending;
    private bool _escapePending;

    public void ObservePtyOutput(ReadOnlySpan<byte> data)
    {
        foreach (var value in data)
        {
            if (!_capturingOsc)
            {
                if (_escapePending)
                {
                    _escapePending = false;
                    if (value == (byte)']')
                    {
                        _capturingOsc = true;
                        _osc.Clear();
                        continue;
                    }
                }

                _escapePending = value == Escape;
                continue;
            }

            if (_oscEscapePending)
            {
                _oscEscapePending = false;
                if (value == (byte)'\\')
                {
                    RecordQuery(CollectionsMarshal.AsSpan(_osc));
                    ResetOscCapture();
                    continue;
                }

                _osc.Add(Escape);
            }

            if (value == Bell)
            {
                RecordQuery(CollectionsMarshal.AsSpan(_osc));
                ResetOscCapture();
                continue;
            }

            if (value == Escape)
            {
                _oscEscapePending = true;
                continue;
            }

            _osc.Add(value);
            if (_osc.Count > MaximumOscBytes)
            {
                ResetOscCapture();
            }
        }
    }

    public bool ShouldSuppressClientResponse(ReadOnlySpan<byte> data)
    {
        if (!TryParseColorResponse(data, out var colorIndex))
        {
            return false;
        }

        lock (_lock)
        {
            if (!_queries.TryGetValue(colorIndex, out var query))
            {
                return false;
            }

            if (query.Answered)
            {
                return true;
            }

            _queries[colorIndex] = query with { Answered = true };
            return _timeProvider.GetElapsedTime(query.Timestamp) > MaximumResponseAge;
        }
    }

    private void RecordQuery(ReadOnlySpan<byte> payload)
    {
        var separator = payload.IndexOf((byte)';');
        if (separator <= 0)
        {
            return;
        }

        if (!Utf8Parser.TryParse(payload[..separator], out int colorIndex, out var consumed) ||
            consumed != separator ||
            colorIndex is < 10 or > 12)
        {
            return;
        }

        var values = payload[(separator + 1)..];
        var timestamp = _timeProvider.GetTimestamp();
        lock (_lock)
        {
            while (colorIndex <= 12)
            {
                var nextSeparator = values.IndexOf((byte)';');
                var value = nextSeparator < 0 ? values : values[..nextSeparator];
                if (value.SequenceEqual("?"u8))
                {
                    _queries[colorIndex] = new PendingQuery(timestamp, Answered: false);
                }

                if (nextSeparator < 0)
                {
                    break;
                }

                colorIndex++;
                values = values[(nextSeparator + 1)..];
            }
        }
    }

    private static bool TryParseColorResponse(ReadOnlySpan<byte> data, out int colorIndex)
    {
        colorIndex = 0;
        if (data.Length < 14 || data[0] != Escape || data[1] != (byte)']')
        {
            return false;
        }

        var terminatorLength = data[^1] == Bell
            ? 1
            : data.Length >= 2 && data[^2] == Escape && data[^1] == (byte)'\\'
                ? 2
                : 0;
        if (terminatorLength == 0)
        {
            return false;
        }

        var payload = data[2..^terminatorLength];
        var separator = payload.IndexOf((byte)';');
        if (separator <= 0 ||
            !Utf8Parser.TryParse(payload[..separator], out colorIndex, out var consumed) ||
            consumed != separator ||
            colorIndex is < 10 or > 12)
        {
            return false;
        }

        var color = payload[(separator + 1)..];
        if (!color.StartsWith("rgb:"u8))
        {
            return false;
        }

        var components = color[4..];
        var firstSlash = components.IndexOf((byte)'/');
        var secondSlash = firstSlash < 0 ? -1 : components[(firstSlash + 1)..].IndexOf((byte)'/');
        if (firstSlash <= 0 || secondSlash <= 0)
        {
            return false;
        }

        secondSlash += firstSlash + 1;
        return IsHexComponent(components[..firstSlash]) &&
            IsHexComponent(components[(firstSlash + 1)..secondSlash]) &&
            IsHexComponent(components[(secondSlash + 1)..]);
    }

    private static bool IsHexComponent(ReadOnlySpan<byte> component)
    {
        return component.Length is >= 1 and <= 4 && component.IndexOfAnyExcept(
            "0123456789abcdefABCDEF"u8) < 0;
    }

    private void ResetOscCapture()
    {
        _capturingOsc = false;
        _oscEscapePending = false;
        _escapePending = false;
        _osc.Clear();
    }

    private readonly record struct PendingQuery(long Timestamp, bool Answered);
}
