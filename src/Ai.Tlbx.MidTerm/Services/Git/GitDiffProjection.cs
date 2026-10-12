using System.Globalization;
using System.Text.RegularExpressions;
using Ai.Tlbx.MidTerm.Models.Git;

namespace Ai.Tlbx.MidTerm.Services.Git;

/// <summary>Coordinates and bounded word comparisons derived from the actual unified patch.</summary>
internal static partial class GitDiffProjection
{
    [GeneratedRegex(@"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking)]
    private static partial Regex HunkCoordinates();
    [GeneratedRegex(@"[\p{L}\p{N}\p{M}_]+|\s+|[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\p{L}\p{N}\p{M}_\s]", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking)]
    private static partial Regex Words();

    internal static void Apply(GitDiffFileView file)
    {
        foreach (var hunk in file.Hunks)
        {
            var match = HunkCoordinates().Match(hunk.Header);
            if (!match.Success) continue;
            hunk.OldStart = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
            hunk.NewStart = int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
            var oldLine = hunk.OldStart; var newLine = hunk.NewStart;
            foreach (var line in hunk.Lines)
            {
                line.OldLine = line.Kind is "del" or "context" ? oldLine++ : null;
                line.NewLine = line.Kind is "add" or "context" ? newLine++ : null;
            }
            var visualRow = 0;
            for (var offset = 0; offset < hunk.Lines.Length;)
            {
                if (hunk.Lines[offset].Kind is not ("add" or "del"))
                { hunk.Lines[offset++].VisualRow = visualRow++; continue; }
                var end = offset;
                while (end < hunk.Lines.Length && hunk.Lines[end].Kind is "add" or "del") end++;
                var block = hunk.Lines[offset..end];
                var deleted = block.Where(line => line.Kind == "del").ToArray();
                var added = block.Where(line => line.Kind == "add").ToArray();
                for (var pair = 0; pair < deleted.Length; pair++) deleted[pair].VisualRow = visualRow + pair;
                for (var pair = 0; pair < added.Length; pair++) added[pair].VisualRow = visualRow + pair;
                for (var pair = 0; pair < Math.Min(deleted.Length, added.Length); pair++)
                    CompareWords(deleted[pair], added[pair]);
                visualRow += Math.Max(deleted.Length, added.Length);
                offset = end;
            }
        }
    }

    private static void CompareWords(GitDiffLine oldLine, GitDiffLine newLine)
    {
        // A pathological one-line/minified file never allocates an unbounded comparison matrix.
        var oldText = oldLine.Text[1..]; var newText = newLine.Text[1..];
        if (oldText.Length > 4096 || newText.Length > 4096) return;
        var oldWords = Words().Matches(oldText).Select(match => match.Value).ToArray();
        var newWords = Words().Matches(newText).Select(match => match.Value).ToArray();
        if (oldWords.Length > 128 || newWords.Length > 128) return;
        var lengths = new ushort[oldWords.Length + 1, newWords.Length + 1];
        for (var i = oldWords.Length - 1; i >= 0; i--)
            for (var j = newWords.Length - 1; j >= 0; j--)
                lengths[i, j] = string.Equals(oldWords[i], newWords[j], StringComparison.Ordinal)
                    ? (ushort)(1 + lengths[i + 1, j + 1]) : Math.Max(lengths[i + 1, j], lengths[i, j + 1]);
        var oldChanged = Enumerable.Repeat(true, oldWords.Length).ToArray();
        var newChanged = Enumerable.Repeat(true, newWords.Length).ToArray();
        var x = 0; var y = 0;
        while (x < oldWords.Length && y < newWords.Length)
        {
            if (string.Equals(oldWords[x], newWords[y], StringComparison.Ordinal))
            { oldChanged[x++] = false; newChanged[y++] = false; }
            else if (lengths[x + 1, y] >= lengths[x, y + 1]) x++;
            else y++;
        }
        oldLine.Segments = Segments(oldWords, oldChanged);
        newLine.Segments = Segments(newWords, newChanged);
    }

    private static GitDiffSegment[] Segments(string[] words, bool[] changed)
    {
        var result = new List<GitDiffSegment>();
        for (var i = 0; i < words.Length; i++)
        {
            if (result.Count > 0 && result[^1].Changed == changed[i]) result[^1].Text += words[i];
            else result.Add(new GitDiffSegment { Text = words[i], Changed = changed[i] });
        }
        return result.ToArray();
    }
}
