using System.Runtime.Versioning;
using System.Security.Principal;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Models.Files;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Services.Git;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class FileServiceIdentityTests
{
    [LocalSystemFileFact]
    [SupportedOSPlatform("windows")]
    public async Task ActualLocalSystemUsesTheVerifiedCallerForFilesAndGit()
    {
        using var system = WindowsIdentity.GetCurrent();
        Assert.True(system.IsSystem);
        using var configuration = JsonDocument.Parse(File.ReadAllText(Environment.GetEnvironmentVariable("TLBX_FILE_IDENTITY_FIXTURE")!));
        var config = configuration.RootElement;
        var root = config.GetProperty("root").GetString()!;
        var sid = config.GetProperty("sid").GetString()!;
        var pid = config.GetProperty("pid").GetInt32();
        var started = DateTime.FromFileTimeUtc(config.GetProperty("started").GetInt64());
        var source = Path.Combine(root, "caller.txt");
        Assert.Throws<UnauthorizedAccessException>(() => File.ReadAllText(source));
        var service = new FileOperationService(config.GetProperty("storage").GetString()!).ForOwner(sid);
        service.GrantStorageOwner(sid);
        bool Accessible(string path) => FileService.IsWithinDirectory(path, root);
        FileOperationRequest Request(string action, params string[] paths) => new()
        { RequestId = Guid.NewGuid().ToString(), Action = action, Paths = paths };
        GitCommandRunner.Configure(null, true);
        try
        {
            await SessionCallerIdentity.RunForSessionAsync(pid, started, async () =>
            {
                using var caller = WindowsIdentity.GetCurrent();
                Assert.Equal(sid, caller.User!.Value); Assert.False(caller.IsSystem);
                Assert.Equal("caller data", File.ReadAllText(source));
                var repository = await GitCommandRunner.GetRepositoryInfoAsync(root);
                Assert.NotNull(repository);
                var ignored = await GitCommandRunner.GetIgnoredPathsAsync(root, ["ignored.tmp", "caller.txt"]);
                Assert.NotNull(ignored); Assert.Contains("ignored.tmp", ignored); Assert.DoesNotContain("caller.txt", ignored);
                using var afterGit = WindowsIdentity.GetCurrent(); Assert.Equal(sid, afterGit.User!.Value);

                foreach (var args in new[] {
                    new[] { "config", "user.name", "Caller Git acceptance" },
                    new[] { "config", "user.email", "caller@tlbx.invalid" },
                    new[] { "config", "commit.gpgSign", "false" } })
                    Assert.Equal(0, (await GitCommandRunner.ExecuteAsync(root, args, default)).ExitCode);
                var gitOperations = new GitOperationService();
                Ai.Tlbx.MidTerm.Models.Git.GitOperationRequest GitRequest(string action) => new()
                { Action = action, OperationId = Guid.NewGuid().ToString("D"), Paths = ["caller.txt"] };
                Assert.Equal("completed", (await gitOperations.ExecuteAsync(root, GitRequest("stage"), default)).State);
                Assert.Equal("completed", (await gitOperations.ExecuteAsync(root, GitRequest("unstage"), default)).State);
                Assert.Equal("caller data", File.ReadAllText(source));
                Assert.Equal("completed", (await gitOperations.ExecuteAsync(root, GitRequest("stage"), default)).State);
                var reviewed = await GitCommandRunner.GetStatusAsync(root);
                var commit = GitRequest("commit"); commit.Message = "Caller identity commit";
                commit.ExpectedIndexVersion = reviewed.IndexVersion; commit.ExpectedHead = reviewed.HeadHash;
                var committed = await gitOperations.ExecuteAsync(root, commit, default);
                Assert.Equal("completed", committed.State); Assert.False(string.IsNullOrEmpty(committed.CommitHash));
                var committedText = await GitCommandRunner.ExecuteAsync(root, ["show", "HEAD:caller.txt"], default);
                Assert.Equal(0, committedText.ExitCode); Assert.Equal("caller data", committedText.Stdout);
                using var afterMutation = WindowsIdentity.GetCurrent(); Assert.Equal(sid, afterMutation.User!.Value);

                var selectedPath = Path.Combine(root, "selected ä.txt");
                await File.WriteAllTextAsync(selectedPath, "Caller first ä\nCaller second 字\n");
                var newFile = Assert.Single((await GitNewFileReview.ReadAsync(root, "selected ä.txt", default)).Files);
                Assert.Equal(2, newFile.Additions); Assert.False(newFile.IsBinary);
                var selectedStatus = await GitCommandRunner.GetStatusAsync(root);
                var snapshot = await GitPatchSelection.ReadAsync(root, "selected ä.txt", false, selectedStatus);
                var selected = new Ai.Tlbx.MidTerm.Models.Git.GitOperationRequest
                {
                    Action = "stage-selection", OperationId = Guid.NewGuid().ToString("D"), Paths = ["selected ä.txt"],
                    ExpectedIndexVersion = selectedStatus.IndexVersion, ExpectedPatchVersion = snapshot.View.PatchVersion,
                    SelectedLines = [new() { Hunk = 0, Line = 0 }]
                };
                Assert.Equal("completed", (await gitOperations.ExecuteAsync(root, selected, default)).State);
                var selectedText = await GitCommandRunner.ExecuteAsync(root, ["show", ":selected ä.txt"], default);
                Assert.Equal(0, selectedText.ExitCode); Assert.Equal("Caller first ä\n", selectedText.Stdout.Replace("\r\n", "\n", StringComparison.Ordinal));
                selectedStatus = await GitCommandRunner.GetStatusAsync(root);
                snapshot = await GitPatchSelection.ReadAsync(root, "selected ä.txt", true, selectedStatus);
                selected.Action = "unstage-selection"; selected.OperationId = Guid.NewGuid().ToString("D");
                selected.ExpectedIndexVersion = selectedStatus.IndexVersion; selected.ExpectedPatchVersion = snapshot.View.PatchVersion;
                selected.SelectedLines = []; selected.SelectedHunks = [0];
                Assert.Equal("completed", (await gitOperations.ExecuteAsync(root, selected, default)).State);
                Assert.Equal("Caller first ä\nCaller second 字\n", await File.ReadAllTextAsync(selectedPath));
                using var afterSelection = WindowsIdentity.GetCurrent(); Assert.Equal(sid, afterSelection.User!.Value);

                var create = Request("createFolder"); create.DestinationDirectory = root; create.Name = "destination";
                Assert.True(Assert.Single((await service.ExecuteAsync(create, Accessible, [root], default)).Items).Success);
                var duplicate = Assert.Single((await service.ExecuteAsync(Request("duplicate", source), Accessible, [root], default)).Items);
                Assert.True(duplicate.Success, duplicate.Message); Assert.Equal("caller data", File.ReadAllText(duplicate.Path!));
                var rename = Request("rename", duplicate.Path!); rename.Name = "renamed.txt";
                var renamed = Assert.Single((await service.ExecuteAsync(rename, Accessible, [root], default)).Items);
                Assert.True(renamed.Success, renamed.Message);
                var move = Request("move", renamed.Path!); move.DestinationDirectory = Path.Combine(root, "destination");
                var moved = Assert.Single((await service.ExecuteAsync(move, Accessible, [root], default)).Items);
                Assert.True(moved.Success, moved.Message);
                var deleted = Assert.Single((await service.ExecuteAsync(Request("delete", moved.Path!), Accessible, [root], default)).Items);
                Assert.True(deleted.Success, deleted.Message); Assert.False(File.Exists(moved.Path!));
                var recovery = new FileOperationService(config.GetProperty("storage").GetString()!).ForOwner(sid);
                var restored = await recovery.RestoreAsync(new() { RecoveryId = deleted.RecoveryId! }, Accessible, default);
                Assert.True(restored.Success); Assert.Equal("caller data", File.ReadAllText(restored.Path!));
                await Assert.ThrowsAsync<UnauthorizedAccessException>(() => service.ExecuteAsync(Request("delete", config.GetProperty("outside").GetString()!), Accessible, [root], default));
                return true;
            });
            using var restoredIdentity = WindowsIdentity.GetCurrent(); Assert.True(restoredIdentity.IsSystem);
            Assert.Throws<UnauthorizedAccessException>(() => File.ReadAllText(source));
        }
        finally { GitCommandRunner.Configure(null, false); }
    }
}

internal sealed class LocalSystemFileFactAttribute : FactAttribute
{
    public LocalSystemFileFactAttribute()
    {
        if (!OperatingSystem.IsWindows() || string.IsNullOrEmpty(Environment.GetEnvironmentVariable("TLBX_FILE_IDENTITY_FIXTURE")))
            Skip = "Requires the isolated LocalSystem fixture from test-file-service-identity.ps1.";
    }
}
