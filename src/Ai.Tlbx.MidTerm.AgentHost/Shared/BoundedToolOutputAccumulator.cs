using System.Text;
using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.AgentHost;

/// <summary>
/// Retains a small semantic window from arbitrarily large streamed tool output.
/// Memory use is bounded independently of the provider's output size.
/// </summary>
public sealed class BoundedToolOutputAccumulator
{
    public const int MaxLineChars = 512;
    public const int HeadLineLimit = 4;
    public const int TailLineLimit = 6;

    private readonly List<string> _headLines = new(HeadLineLimit);
    private readonly StringBuilder[] _tailLines = CreateTailLineBuffers();
    private readonly StringBuilder _pendingLine = new(MaxLineChars);
    private int _tailStart;
    private int _tailCount;
    private bool _pendingLineTruncated;
    private bool _lastCharacterWasCarriageReturn;
    private EscapeState _escapeState;

    public int TotalLineCount { get; private set; }
    public bool HasContent => TotalLineCount > 0 || _pendingLine.Length > 0 || _pendingLineTruncated;

    public void Append(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return;
        }

        foreach (var character in value.AsSpan())
        {
            if (ConsumeEscapeCharacter(character))
            {
                continue;
            }
            if (character == '\u001b')
            {
                _escapeState = EscapeState.Escape;
                continue;
            }
            if (character == '\r')
            {
                CompleteLine();
                _lastCharacterWasCarriageReturn = true;
                continue;
            }

            if (character == '\n')
            {
                if (!_lastCharacterWasCarriageReturn)
                {
                    CompleteLine();
                }

                _lastCharacterWasCarriageReturn = false;
                continue;
            }

            _lastCharacterWasCarriageReturn = false;
            if (char.IsControl(character) && character != '\t')
            {
                continue;
            }
            if (_pendingLine.Length < MaxLineChars)
            {
                _pendingLine.Append(character);
            }
            else
            {
                _pendingLineTruncated = true;
            }
        }
    }

    public AppServerControlToolPresentation ApplyTo(
        AppServerControlToolPresentation presentation,
        string status)
    {
        ArgumentNullException.ThrowIfNull(presentation);
        var lines = SnapshotLines();
        if (lines.Count == 0)
        {
            presentation.Evidence = null;
            presentation.TotalLineCount = 0;
            presentation.OmittedLineCount = 0;
            return presentation;
        }

        var failed = string.Equals(status, "failed", StringComparison.OrdinalIgnoreCase);
        var read = string.Equals(presentation.Category, "read", StringComparison.Ordinal);
        var selected = failed
            ? SelectTail(lines)
            : read
                ? SelectHead(lines)
                : SelectCommandOrGeneric(lines);

        presentation.Evidence = string.Join('\n', selected);
        presentation.EvidenceKind = failed ? "error" : "output";
        presentation.TotalLineCount = CountCurrentLine();
        presentation.OmittedLineCount = Math.Max(0, presentation.TotalLineCount - selected.Count);
        return presentation;
    }

    public BoundedToolOutputSnapshot Export()
    {
        return new BoundedToolOutputSnapshot
        {
            HeadLines = [.. _headLines],
            TailLines = GetTailLineStrings(),
            PendingLine = _pendingLine.ToString(),
            PendingLineTruncated = _pendingLineTruncated,
            LastCharacterWasCarriageReturn = _lastCharacterWasCarriageReturn,
            EscapeState = (int)_escapeState,
            TotalLineCount = TotalLineCount
        };
    }

    public void Restore(BoundedToolOutputSnapshot? snapshot)
    {
        _headLines.Clear();
        ClearTailLines();
        _pendingLine.Clear();
        _pendingLineTruncated = false;
        _lastCharacterWasCarriageReturn = false;
        _escapeState = EscapeState.None;
        TotalLineCount = 0;
        if (snapshot is null)
        {
            return;
        }

        CopyBounded(snapshot.HeadLines, _headLines, HeadLineLimit);
        RestoreTailLines(snapshot.TailLines);
        AppendPending(snapshot.PendingLine);
        _pendingLineTruncated = snapshot.PendingLineTruncated ||
                                (snapshot.PendingLine?.Length ?? 0) > MaxLineChars;
        _lastCharacterWasCarriageReturn = snapshot.LastCharacterWasCarriageReturn;
        _escapeState = Enum.IsDefined((EscapeState)snapshot.EscapeState)
            ? (EscapeState)snapshot.EscapeState
            : EscapeState.None;
        TotalLineCount = Math.Max(snapshot.TotalLineCount, _headLines.Count);
    }

    private void CompleteLine()
    {
        if (_headLines.Count < HeadLineLimit)
        {
            _headLines.Add(BuildPendingLine());
        }

        var tailIndex = (_tailStart + _tailCount) % TailLineLimit;
        if (_tailCount == TailLineLimit)
        {
            tailIndex = _tailStart;
            _tailStart = (_tailStart + 1) % TailLineLimit;
        }
        else
        {
            _tailCount++;
        }
        var tailLine = _tailLines[tailIndex];
        tailLine.Clear();
        tailLine.Append(_pendingLine);
        if (_pendingLineTruncated)
        {
            tailLine.Append('…');
        }
        TotalLineCount++;
        _pendingLine.Clear();
        _pendingLineTruncated = false;
    }

    private List<string> SnapshotLines()
    {
        var totalLines = CountCurrentLine();
        if (totalLines == 0)
        {
            return [];
        }

        var pending = _pendingLine.Length > 0 || _pendingLineTruncated
            ? BuildPendingLine()
            : null;
        if (totalLines <= TailLineLimit)
        {
            var all = new List<string>(totalLines);
            all.AddRange(GetTailLineStrings());
            if (pending is not null)
            {
                all.Add(pending);
            }
            return all;
        }

        var window = new List<string>(HeadLineLimit + TailLineLimit + 1);
        window.AddRange(_headLines);
        window.AddRange(GetTailLineStrings());
        if (pending is not null)
        {
            window.Add(pending);
        }
        return window;
    }

    private List<string> SelectCommandOrGeneric(List<string> lines)
    {
        var totalLines = CountCurrentLine();
        if (totalLines <= TailLineLimit)
        {
            return RemoveLeadingBlankLines(lines);
        }

        var selected = new List<string>(TailLineLimit + 1);
        var firstMeaningful = _headLines.FirstOrDefault(static line => !string.IsNullOrWhiteSpace(line));
        if (!string.IsNullOrWhiteSpace(firstMeaningful))
        {
            selected.Add(firstMeaningful);
        }

        foreach (var line in GetTailWithPending())
        {
            if (selected.Count == 1 && string.Equals(selected[0], line, StringComparison.Ordinal))
            {
                continue;
            }

            selected.Add(line);
        }

        return selected;
    }

    private List<string> SelectHead(List<string> lines)
    {
        return RemoveLeadingBlankLines(lines.Take(HeadLineLimit).ToList());
    }

    private List<string> SelectTail(List<string> lines)
    {
        var tail = lines.Count <= TailLineLimit
            ? lines
            : lines.Skip(lines.Count - TailLineLimit).ToList();
        return RemoveLeadingBlankLines(tail);
    }

    private List<string> GetTailWithPending()
    {
        var tail = new List<string>(TailLineLimit + 1);
        tail.AddRange(GetTailLineStrings());
        if (_pendingLine.Length > 0 || _pendingLineTruncated)
        {
            if (tail.Count == TailLineLimit)
            {
                tail.RemoveAt(0);
            }
            tail.Add(BuildPendingLine());
        }
        return tail;
    }

    private static List<string> RemoveLeadingBlankLines(List<string> lines)
    {
        var first = 0;
        while (first < lines.Count && string.IsNullOrWhiteSpace(lines[first]))
        {
            first++;
        }

        return first == 0 ? lines : lines.Skip(first).ToList();
    }

    private int CountCurrentLine()
    {
        return TotalLineCount + (_pendingLine.Length > 0 || _pendingLineTruncated ? 1 : 0);
    }

    private string BuildPendingLine()
    {
        return _pendingLineTruncated ? _pendingLine + "…" : _pendingLine.ToString();
    }

    private void AppendPending(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return;
        }

        _pendingLine.Append(value.AsSpan(0, Math.Min(value.Length, MaxLineChars)));
    }

    private void RestoreTailLines(IEnumerable<string>? source)
    {
        if (source is null)
        {
            return;
        }

        foreach (var line in source.Take(TailLineLimit))
        {
            var target = _tailLines[_tailCount++];
            target.Append(line.AsSpan(0, Math.Min(line.Length, MaxLineChars + 1)));
        }
    }

    private static void CopyBounded(IEnumerable<string>? source, ICollection<string> target, int limit)
    {
        if (source is null)
        {
            return;
        }

        foreach (var line in source.Take(limit))
        {
            target.Add(line.Length <= MaxLineChars + 1 ? line : line[..(MaxLineChars + 1)]);
        }
    }

    private List<string> GetTailLineStrings()
    {
        var result = new List<string>(_tailCount);
        for (var index = 0; index < _tailCount; index++)
        {
            result.Add(_tailLines[(_tailStart + index) % TailLineLimit].ToString());
        }
        return result;
    }

    private void ClearTailLines()
    {
        foreach (var line in _tailLines)
        {
            line.Clear();
        }
        _tailStart = 0;
        _tailCount = 0;
    }

    private static StringBuilder[] CreateTailLineBuffers()
    {
        var result = new StringBuilder[TailLineLimit];
        for (var index = 0; index < result.Length; index++)
        {
            result[index] = new StringBuilder(MaxLineChars + 1);
        }
        return result;
    }

    private bool ConsumeEscapeCharacter(char character)
    {
        switch (_escapeState)
        {
            case EscapeState.None:
                return false;
            case EscapeState.Escape:
                _escapeState = character switch
                {
                    '[' => EscapeState.ControlSequence,
                    ']' => EscapeState.OperatingSystemCommand,
                    _ => EscapeState.None
                };
                return true;
            case EscapeState.ControlSequence:
                if (character is >= '@' and <= '~')
                {
                    _escapeState = EscapeState.None;
                }
                return true;
            case EscapeState.OperatingSystemCommand:
                if (character == '\a')
                {
                    _escapeState = EscapeState.None;
                }
                else if (character == '\u001b')
                {
                    _escapeState = EscapeState.OperatingSystemCommandEscape;
                }
                return true;
            case EscapeState.OperatingSystemCommandEscape:
                _escapeState = character == '\\'
                    ? EscapeState.None
                    : character == '\u001b'
                        ? EscapeState.OperatingSystemCommandEscape
                        : EscapeState.OperatingSystemCommand;
                return true;
            default:
                _escapeState = EscapeState.None;
                return true;
        }
    }

    private enum EscapeState
    {
        None,
        Escape,
        ControlSequence,
        OperatingSystemCommand,
        OperatingSystemCommandEscape
    }
}

public sealed class BoundedToolOutputSnapshot
{
    public List<string> HeadLines { get; init; } = [];
    public List<string> TailLines { get; init; } = [];
    public string? PendingLine { get; init; }
    public bool PendingLineTruncated { get; init; }
    public bool LastCharacterWasCarriageReturn { get; init; }
    public int EscapeState { get; init; }
    public int TotalLineCount { get; init; }
}

public sealed class BoundedTextAccumulator(int maxChars)
{
    private readonly StringBuilder _builder = new(Math.Min(Math.Max(1, maxChars), 4_096));
    private readonly int _maxChars = Math.Max(1, maxChars);

    public bool IsTruncated { get; private set; }
    public int Length => _builder.Length;

    public void Append(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return;
        }

        var remaining = _maxChars - _builder.Length;
        if (remaining <= 0)
        {
            IsTruncated = true;
            return;
        }

        var take = Math.Min(remaining, value.Length);
        _builder.Append(value.AsSpan(0, take));
        IsTruncated |= take < value.Length;
    }

    public override string ToString() => _builder.ToString();
}
