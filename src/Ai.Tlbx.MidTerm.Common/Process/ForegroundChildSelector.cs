namespace Ai.Tlbx.MidTerm.Common.Process;

public readonly record struct ForegroundChildCandidate(
    int Pid,
    string? Name,
    bool HasVisibleWindow,
    DateTimeOffset? StartedAtUtc);

public static class ForegroundChildSelector
{
    private static readonly HashSet<string> ShellWrapperNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "cmd",
        "pwsh",
        "powershell",
        "bash",
        "sh",
        "zsh",
        "fish",
        "nu"
    };

    public static ForegroundChildCandidate? SelectBest(IEnumerable<ForegroundChildCandidate> candidates)
    {
        ForegroundChildCandidate? best = null;
        foreach (var candidate in candidates)
        {
            if (best is null || Compare(candidate, best.Value) > 0)
            {
                best = candidate;
            }
        }

        return best;
    }

    private static int Compare(ForegroundChildCandidate left, ForegroundChildCandidate right)
    {
        var visibleWindowComparison = CompareBoolFalsePreferred(left.HasVisibleWindow, right.HasVisibleWindow);
        if (visibleWindowComparison != 0)
        {
            return visibleWindowComparison;
        }

        var shellWrapperComparison = CompareBoolFalsePreferred(
            IsShellWrapper(left.Name),
            IsShellWrapper(right.Name));
        if (shellWrapperComparison != 0)
        {
            return shellWrapperComparison;
        }

        var startedAtComparison = Nullable.Compare(left.StartedAtUtc, right.StartedAtUtc);
        if (startedAtComparison != 0)
        {
            return startedAtComparison;
        }

        return left.Pid.CompareTo(right.Pid);
    }

    private static int CompareBoolFalsePreferred(bool left, bool right)
    {
        if (left == right)
        {
            return 0;
        }

        return left ? -1 : 1;
    }

    private static bool IsShellWrapper(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return false;
        }

        return ShellWrapperNames.Contains(name);
    }
}
