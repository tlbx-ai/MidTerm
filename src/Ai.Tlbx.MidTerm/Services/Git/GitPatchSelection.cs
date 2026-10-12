using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Ai.Tlbx.MidTerm.Models.Git;

namespace Ai.Tlbx.MidTerm.Services.Git;

internal sealed record GitPatchSnapshot(string Patch, GitDiffViewResponse View);

/// <summary>Builds a selected patch on the server from the exact reviewed native Git diff.</summary>
internal static class GitPatchSelection
{
    internal static async Task<GitPatchSnapshot> ReadAsync(string root, string path, bool staged, GitStatusResponse status)
    {
        var entry = (staged ? status.Staged : status.Modified.Concat(status.Untracked).ToArray())
            .FirstOrDefault(file => file.Path == path);
        var (patch, truncated) = await GitCommandRunner.GetDiffPatchAsync(root, path, staged,
            entry?.OriginalPath, untracked: !staged && entry?.Status == "untracked").ConfigureAwait(false);
        var view = GitPatchParser.ParseDiff(staged ? "staged" : "worktree", patch, truncated);
        view.PatchVersion = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(patch)));
        view.IndexVersion = status.IndexVersion;
        view.CanSelectLines = !truncated && view.Files is [var file] && !file.IsBinary && file.Hunks.Length > 0;
        return new GitPatchSnapshot(patch, view);
    }

    internal static string Build(GitPatchSnapshot snapshot, GitOperationRequest request)
    {
        if (!snapshot.View.CanSelectLines)
            throw new GitOperationException(409, "selection_unavailable", "This file does not have a complete text patch. Use the whole-file action.");
        if (snapshot.View.PatchVersion != request.ExpectedPatchVersion)
            throw new GitOperationException(409, "diff_changed", "The reviewed diff changed. Refresh it and select the changes again.");
        var file = snapshot.View.Files[0];
        var hunks = RawHunks(snapshot.Patch);
        var selectedHunks = request.SelectedHunks.ToHashSet();
        var selectedLines = request.SelectedLines.Select(line => (line.Hunk, line.Line)).ToHashSet();
        if (selectedHunks.Any(hunk => hunk < 0 || hunk >= hunks.Count) ||
            selectedLines.Any(line => line.Hunk < 0 || line.Hunk >= hunks.Count || line.Line < 0 || line.Line >= hunks[line.Hunk].Count || hunks[line.Hunk][line.Line][0] is not ('+' or '-')))
            throw new GitOperationException(400, "invalid_selection", "Select changed lines from the reviewed patch.");
        var reverse = request.Action == "unstage-selection";
        var output = new List<(int Start, List<string> Lines)>();
        var changes = 0;
        for (var hunk = 0; hunk < hunks.Count; hunk++)
        {
            var lines = new List<string>(); var changed = false; var precedingIncluded = false;
            for (var line = 0; line < hunks[hunk].Count; line++)
            {
                var raw = hunks[hunk][line]; var kind = raw[0];
                if (kind == '\\') { if (precedingIncluded) lines.Add(raw); continue; }
                var selected = kind is '+' or '-' && (selectedHunks.Contains(hunk) || selectedLines.Contains((hunk, line)));
                if (selected) { lines.Add((reverse ? kind == '+' ? "-" : "+" : kind.ToString()) + raw[1..]); changed = true; changes++; precedingIncluded = true; }
                else if (kind == ' ' || kind == (reverse ? '+' : '-')) { lines.Add(" " + raw[1..]); precedingIncluded = true; }
                else precedingIncluded = false;
            }
            if (changed) output.Add((reverse ? file.Hunks[hunk].NewStart : file.Hunks[hunk].OldStart, lines));
        }
        if (changes == 0) throw new GitOperationException(400, "selection_required", "Select at least one changed line or hunk.");
        return WritePatch(snapshot.Patch, file, output, reverse);
    }

    private static List<List<string>> RawHunks(string patch)
    {
        var hunks = new List<List<string>>();
        foreach (var line in patch.Split('\n'))
        {
            if (line.StartsWith("@@ ", StringComparison.Ordinal)) hunks.Add([]);
            else if (hunks.Count > 0 && line.Length > 0 && line[0] is '+' or '-' or ' ' or '\\') hunks[^1].Add(line);
        }
        return hunks;
    }

    private static string WritePatch(string raw, GitDiffFileView file, List<(int Start, List<string> Lines)> hunks, bool reverse)
    {
        var absentBase = reverse ? file.Status == "deleted" : file.Status == "added";
        var absentResult = (reverse ? file.Status == "added" : file.Status == "deleted") &&
            hunks.Sum(hunk => hunk.Lines.Count(line => line[0] is ' ' or '+')) == 0;
        var rename = !reverse && file.Status == "renamed" && file.OriginalPath is not null;
        var oldPath = rename ? file.OriginalPath! : file.Path;
        var patch = new StringBuilder().Append("diff --git ").Append(Quote("a/" + oldPath)).Append(' ').Append(Quote("b/" + file.Path)).Append('\n');
        var mode = raw.Split('\n').FirstOrDefault(line => line.StartsWith("new file mode ", StringComparison.Ordinal) || line.StartsWith("deleted file mode ", StringComparison.Ordinal))?.Split(' ')[^1] ?? "100644";
        if (absentBase) patch.Append("new file mode ").Append(mode).Append('\n');
        else if (absentResult) patch.Append("deleted file mode ").Append(mode).Append('\n');
        else if (rename) patch.Append("rename from ").Append(Quote(oldPath)).Append("\nrename to ").Append(Quote(file.Path)).Append('\n');
        patch.Append("--- ").Append(absentBase ? "/dev/null" : Quote("a/" + oldPath)).Append("\n+++ ").Append(absentResult ? "/dev/null" : Quote("b/" + file.Path)).Append('\n');
        var delta = 0;
        foreach (var (start, lines) in hunks)
        {
            var oldCount = lines.Count(line => line[0] is ' ' or '-');
            var newCount = lines.Count(line => line[0] is ' ' or '+');
            var newStart = start + delta + (oldCount == 0 ? 1 : newCount == 0 ? -1 : 0);
            patch.Append(CultureInfo.InvariantCulture, $"@@ -{start},{oldCount} +{newStart},{newCount} @@\n");
            foreach (var line in lines) patch.Append(line).Append('\n');
            delta += newCount - oldCount;
        }
        return patch.ToString();
    }

    private static string Quote(string path) => "\"" + path.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal)
        .Replace("\t", "\\t", StringComparison.Ordinal).Replace("\r", "\\r", StringComparison.Ordinal).Replace("\n", "\\n", StringComparison.Ordinal) + "\"";
}
