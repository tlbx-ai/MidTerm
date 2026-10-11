using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;
using Ai.Tlbx.MidTerm.Models.Files;
using Ai.Tlbx.MidTerm.Services;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class FileOperationServiceTests : IDisposable
{
    private readonly string _base = Path.Combine(Path.GetTempPath(), "file_operations_test_" + Guid.NewGuid().ToString("N"));
    private readonly string _workspace;
    private readonly string _storage;
    private readonly FileOperationService _operations;

    public FileOperationServiceTests()
    {
        _workspace = Path.Combine(_base, "workspace"); _storage = Path.Combine(_base, "storage");
        Directory.CreateDirectory(_workspace); Directory.CreateDirectory(_storage);
        _operations = new(_storage);
    }

    private bool Accessible(string path) => FileService.IsWithinDirectory(path, _workspace);
    private Task<FileOperationResponse> Run(FileOperationRequest request, CancellationToken ct = default) =>
        _operations.ExecuteAsync(request, Accessible, [_workspace], ct);
    private FileOperationRequest Request(string action, params string[] paths) => new()
    { RequestId = Guid.NewGuid().ToString(), Action = action, Paths = paths };
    private string FileWith(string name, string content = "original 🎸\r\n")
    { var path = Path.Combine(_workspace, name); Directory.CreateDirectory(Path.GetDirectoryName(path)!); File.WriteAllText(path, content); return path; }

    [Fact]
    public async Task CreationProducesRealEmptyFileAndFolderAndRejectsCollision()
    {
        foreach (var action in new[] { "createFile", "createFolder" })
        {
            var request = Request(action); request.DestinationDirectory = _workspace; request.Name = "Ünicode " + action;
            var item = Assert.Single((await Run(request)).Items); Assert.True(item.Success);
            Assert.Equal(Path.Combine(_workspace, request.Name), item.Path);
            if (action == "createFile") Assert.Empty(await File.ReadAllBytesAsync(item.Path!)); else Assert.True(Directory.Exists(item.Path));
            request.RequestId = Guid.NewGuid().ToString();
            var collision = Assert.Single((await Run(request)).Items); Assert.False(collision.Success); Assert.Equal("name_conflict", collision.Code);
        }
        Assert.Empty(Directory.EnumerateFileSystemEntries(_workspace, ".tlbx-ops-*"));
    }

    [Fact]
    public async Task RenameMoveDuplicateAndCopyPreserveActualBytes()
    {
        var original = FileWith("ältere Datei.md"); var bytes = await File.ReadAllBytesAsync(original);
        var rename = Request("rename", original); rename.Name = "renamed.md";
        var renamed = Assert.Single((await Run(rename)).Items); Assert.True(renamed.Success); Assert.False(File.Exists(original));
        var duplicate = Assert.Single((await Run(Request("duplicate", renamed.Path!))).Items); Assert.True(duplicate.Success);
        Assert.EndsWith("renamed (2).md", duplicate.Path, StringComparison.Ordinal); Assert.Equal(bytes, await File.ReadAllBytesAsync(duplicate.Path!));
        var destination = Path.Combine(_workspace, "destination"); Directory.CreateDirectory(destination);
        var copy = Request("copy", renamed.Path!); copy.DestinationDirectory = destination;
        var copied = Assert.Single((await Run(copy)).Items); Assert.True(copied.Success); Assert.True(File.Exists(renamed.Path));
        var move = Request("move", duplicate.Path!); move.DestinationDirectory = destination;
        var moved = Assert.Single((await Run(move)).Items); Assert.True(moved.Success); Assert.False(File.Exists(duplicate.Path));
        Assert.Equal(bytes, await File.ReadAllBytesAsync(copied.Path!)); Assert.Equal(bytes, await File.ReadAllBytesAsync(moved.Path!));
    }

    [Fact]
    public async Task RequestReplayIsIdempotentAcrossServiceRestart()
    {
        var source = FileWith("notes.txt"); var request = Request("duplicate", source);
        var result = await Run(request);
        var restarted = new FileOperationService(_storage);
        var replay = await restarted.ExecuteAsync(request, Accessible, [_workspace], default);
        Assert.Equal(Assert.Single(result.Items).Path, Assert.Single(replay.Items).Path);
        Assert.Equal(2, Directory.EnumerateFiles(_workspace).Count());
        request.Action = "delete";
        var error = await Assert.ThrowsAsync<FileDocumentException>(() => Run(request)); Assert.Equal("request_reused", error.Code);
        Assert.True(File.Exists(source));
    }

    [Fact]
    public async Task DeletePersistsRecoveryOutsideWorktreeAndRestoresAfterRestart()
    {
        var source = FileWith("deleted 🎸.txt"); var bytes = await File.ReadAllBytesAsync(source);
        var item = Assert.Single((await Run(Request("delete", source))).Items); Assert.True(item.Success); Assert.False(File.Exists(source));
        Assert.Empty(Directory.EnumerateFileSystemEntries(_workspace));
        var restarted = new FileOperationService(_storage);
        var entry = Assert.Single(restarted.ListRecovery(_workspace, null, Accessible).Entries); Assert.Equal(source, entry.OriginalPath);
        var restore = new FileRestoreRequest { RecoveryId = item.RecoveryId! };
        var restored = await restarted.RestoreAsync(restore, Accessible, default); Assert.True(restored.Success); Assert.Equal(source, restored.Path);
        Assert.Equal(bytes, await File.ReadAllBytesAsync(source));
        var again = await restarted.RestoreAsync(restore, Accessible, default); Assert.Equal(source, again.Path);
        Assert.Empty(restarted.ListRecovery(_workspace, null, Accessible).Entries);
    }

    [Fact]
    public async Task RestoreCollisionNeverOverwritesNewFileAndKeepBothPreservesBothVersions()
    {
        var source = FileWith("name.txt", "old"); var deleted = Assert.Single((await Run(Request("delete", source))).Items);
        File.WriteAllText(source, "new"); var request = new FileRestoreRequest { RecoveryId = deleted.RecoveryId! };
        var error = await Assert.ThrowsAsync<FileDocumentException>(() => _operations.RestoreAsync(request, Accessible, default)); Assert.Equal("name_conflict", error.Code);
        Assert.Equal("new", await File.ReadAllTextAsync(source)); request.Conflict = "keepBoth";
        var restored = await _operations.RestoreAsync(request, Accessible, default);
        Assert.Equal("old", await File.ReadAllTextAsync(restored.Path!)); Assert.Equal("new", await File.ReadAllTextAsync(source));
    }

    [Fact]
    public async Task ReplacingDestinationKeepsItsPreviousVersionRecoverable()
    {
        var source = FileWith("source.txt", "source"); var dest = Path.Combine(_workspace, "dest"); Directory.CreateDirectory(dest);
        var target = Path.Combine(dest, "source.txt"); File.WriteAllText(target, "previous target");
        var request = Request("copy", source); request.DestinationDirectory = dest;
        var collision = Assert.Single((await Run(request)).Items); Assert.False(collision.Success); Assert.Equal("name_conflict", collision.Code);
        Assert.Equal("previous target", await File.ReadAllTextAsync(target));
        request.RequestId = Guid.NewGuid().ToString(); request.Conflict = "replace";
        var replacement = Assert.Single((await Run(request)).Items); Assert.True(replacement.Success); Assert.NotNull(replacement.RecoveryId);
        Assert.Equal("source", await File.ReadAllTextAsync(target));
        var old = await _operations.RestoreAsync(new() { RecoveryId = replacement.RecoveryId!, Conflict = "keepBoth" }, Accessible, default);
        Assert.Equal("previous target", await File.ReadAllTextAsync(old.Path!)); Assert.Equal("source", await File.ReadAllTextAsync(target));
    }

    [Fact]
    public async Task MultiSelectionReportsPartialFailureWithoutChangingConflictingDestination()
    {
        string a = FileWith("a.txt", "A"), b = FileWith("b.txt", "B");
        var dest = Path.Combine(_workspace, "dest"); Directory.CreateDirectory(dest); File.WriteAllText(Path.Combine(dest, "b.txt"), "keep");
        var request = Request("copy", a, b); request.DestinationDirectory = dest;
        var result = await Run(request); Assert.True(result.Complete); Assert.Equal(2, result.Items.Length);
        Assert.True(result.Items[0].Success); Assert.False(result.Items[1].Success);
        Assert.Equal("A", File.ReadAllText(Path.Combine(dest, "a.txt"))); Assert.Equal("keep", File.ReadAllText(Path.Combine(dest, "b.txt")));
    }

    [Fact]
    public async Task SelectedFolderAndItsChildAreDeletedOnceAndRecoveredTogether()
    {
        var child = FileWith("folder/child.txt"); var folder = Path.GetDirectoryName(child)!;
        var result = await Run(Request("delete", child, folder)); Assert.All(result.Items, item => Assert.True(item.Success));
        Assert.Single(result.Items.Select(item => item.RecoveryId).Distinct(StringComparer.Ordinal));
        Assert.Single(_operations.ListRecovery(_workspace, null, Accessible).Entries);
        await _operations.RestoreAsync(new() { RecoveryId = result.Items[0].RecoveryId! }, Accessible, default);
        Assert.Equal("original 🎸\r\n", await File.ReadAllTextAsync(child));
    }

    [Fact]
    public async Task RestoringAFileRecreatesItsMissingAuthorizedParent()
    {
        var child = FileWith("parent/child.txt"); var deleted = Assert.Single((await Run(Request("delete", child))).Items);
        var folderRequest = Request("delete", Path.GetDirectoryName(child)!); await Run(folderRequest);
        Assert.Equal(2, _operations.ListRecovery(_workspace, null, Accessible).Entries.Length);
        await _operations.RestoreAsync(new() { RecoveryId = deleted.RecoveryId! }, Accessible, default);
        Assert.Equal("original 🎸\r\n", await File.ReadAllTextAsync(child));
        var replay = await Run(folderRequest); Assert.True(Assert.Single(replay.Items).Success);
    }

    [Fact]
    public async Task ExplicitFolderReplacementRetainsAllPreviousDestinationContents()
    {
        var source = FileWith("source-folder/new.txt", "new"); var dest = Path.Combine(_workspace, "dest");
        Directory.CreateDirectory(Path.Combine(dest, "source-folder")); File.WriteAllText(Path.Combine(dest, "source-folder", "old.txt"), "old");
        var request = Request("copy", Path.GetDirectoryName(source)!); request.DestinationDirectory = dest; request.Conflict = "replace";
        var result = Assert.Single((await Run(request)).Items); Assert.True(result.Success, result.Message);
        Assert.Equal("new", await File.ReadAllTextAsync(Path.Combine(result.Path!, "new.txt")));
        Assert.False(File.Exists(Path.Combine(result.Path!, "old.txt")));
        var old = await _operations.RestoreAsync(new() { RecoveryId = result.RecoveryId!, Conflict = "keepBoth" }, Accessible, default);
        Assert.Equal("old", await File.ReadAllTextAsync(Path.Combine(old.Path!, "old.txt")));
    }

    [CrossVolumeWindowsFact]
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    public async Task CrossVolumeRecoveryUsesGitMetadataAndRetainsExistingAclAndOwner()
    {
        var repository = Path.Combine("Q:\\repos\\tlbx-2\\.dev\\file-git-production", "volume-fixture-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(repository);
        try
        {
            await GitAsync(repository, "init", "--quiet");
            var source = Path.Combine(repository, "protected.txt"); File.WriteAllText(source, "actual data");
            var crossDevice = Assert.Throws<IOException>(() => FileEntryLinks.MoveWindows(source, Path.Combine(_workspace, "volume-probe.txt")));
            Assert.Equal(17, crossDevice.HResult & 0xFFFF); Assert.True(File.Exists(source));
            var before = new FileInfo(source).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner).GetSecurityDescriptorSddlForm(AccessControlSections.Access | AccessControlSections.Owner);
            bool Allowed(string path) => Accessible(path) || FileService.IsWithinDirectory(path, repository);
            var response = await _operations.ExecuteAsync(Request("delete", source), Allowed, [_workspace, repository], default);
            var deleted = Assert.Single(response.Items); Assert.True(deleted.Success, deleted.Message); Assert.False(File.Exists(source));
            Assert.DoesNotContain("tlbx", await GitAsync(repository, "status", "--porcelain", "--untracked-files=all"), StringComparison.OrdinalIgnoreCase);
            await _operations.RestoreAsync(new() { RecoveryId = deleted.RecoveryId! }, Allowed, default);
            Assert.Equal("actual data", File.ReadAllText(source));
            Assert.Equal(before, new FileInfo(source).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner).GetSecurityDescriptorSddlForm(AccessControlSections.Access | AccessControlSections.Owner));
            var incoming = FileWith("incoming.txt", "cross-volume move");
            var move = Request("move", incoming); move.DestinationDirectory = repository;
            var moved = Assert.Single((await _operations.ExecuteAsync(move, Allowed, [_workspace, repository], default)).Items);
            Assert.True(moved.Success, moved.Message); Assert.False(File.Exists(incoming)); Assert.Equal("cross-volume move", File.ReadAllText(moved.Path!));
            Assert.DoesNotContain("tlbx", await GitAsync(repository, "status", "--porcelain", "--untracked-files=all"), StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            var full = Path.GetFullPath(repository);
            Assert.True(FileService.IsWithinDirectory(full, "Q:\\repos\\tlbx-2\\.dev\\file-git-production"));
            Assert.StartsWith("volume-fixture-", Path.GetFileName(full), StringComparison.Ordinal);
            PrepareFixtureCleanup(full); Directory.Delete(full, recursive: true);
        }
    }

    private static async Task<string> GitAsync(string directory, params string[] arguments)
    {
        var start = new ProcessStartInfo("git") { WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start)!; var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync(); var output = await stdout; Assert.True(process.ExitCode == 0, await stderr); return output;
    }

    [WindowsFact]
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    public async Task RestoringIntoAMissingParentRetainsItsProtectedSecurityDescriptor()
    {
        var child = FileWith("private-parent/child.txt"); var parent = Path.GetDirectoryName(child)!;
        using var identity = WindowsIdentity.GetCurrent(); var security = new DirectorySecurity(); security.SetAccessRuleProtection(true, false);
        security.SetOwner(identity.User!); security.AddAccessRule(new(identity.User!, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(parent).SetAccessControl(security);
        var before = new DirectoryInfo(parent).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner | AccessControlSections.Group)
            .GetSecurityDescriptorSddlForm(AccessControlSections.Access | AccessControlSections.Owner | AccessControlSections.Group);
        var deleted = Assert.Single((await Run(Request("delete", child))).Items); await Run(Request("delete", parent));
        await _operations.RestoreAsync(new() { RecoveryId = deleted.RecoveryId! }, Accessible, default);
        Assert.Equal(before, new DirectoryInfo(parent).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner | AccessControlSections.Group)
            .GetSecurityDescriptorSddlForm(AccessControlSections.Access | AccessControlSections.Owner | AccessControlSections.Group));
        Assert.Equal("original 🎸\r\n", File.ReadAllText(child));
    }

    [WindowsFact]
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    public async Task NativeRecoveryRetainsProtectedAclOwnershipAndAlternateStream()
    {
        var source = FileWith("protected.txt"); using var identity = WindowsIdentity.GetCurrent();
        var security = new FileSecurity(); security.SetAccessRuleProtection(true, false);
        security.SetOwner(identity.User!);
        security.AddAccessRule(new(identity.User!, FileSystemRights.FullControl, AccessControlType.Allow));
        new FileInfo(source).SetAccessControl(security);
        File.WriteAllText(source + ":metadata", "alternate stream");
        var before = new FileInfo(source).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner).GetSecurityDescriptorSddlForm(AccessControlSections.Access | AccessControlSections.Owner);
        var duplicate = Assert.Single((await Run(Request("duplicate", source))).Items); Assert.True(duplicate.Success, duplicate.Message);
        Assert.Equal("alternate stream", File.ReadAllText(duplicate.Path! + ":metadata"));
        var deleted = Assert.Single((await Run(Request("delete", source))).Items); Assert.True(deleted.Success, deleted.Message);
        await _operations.RestoreAsync(new() { RecoveryId = deleted.RecoveryId! }, Accessible, default);
        Assert.Equal(before, new FileInfo(source).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner).GetSecurityDescriptorSddlForm(AccessControlSections.Access | AccessControlSections.Owner));
        Assert.Equal("alternate stream", File.ReadAllText(source + ":metadata"));
    }

    [WindowsFact]
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    public async Task RecoveryIsPrivateAndRestoreRetainsTheOriginalHiddenAttribute()
    {
        var source = FileWith("visible.txt"); var deleted = Assert.Single((await Run(Request("delete", source))).Items);
        var acl = new DirectoryInfo(Path.Combine(_storage, "file-recovery")).GetAccessControl(); Assert.True(acl.AreAccessRulesProtected);
        var forbidden = new[] { WellKnownSidType.WorldSid, WellKnownSidType.AuthenticatedUserSid, WellKnownSidType.BuiltinUsersSid };
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            Assert.False(rule.AccessControlType == AccessControlType.Allow && forbidden.Any(type => ((SecurityIdentifier)rule.IdentityReference).IsWellKnown(type)));
        await _operations.RestoreAsync(new() { RecoveryId = deleted.RecoveryId! }, Accessible, default);
        Assert.Equal((FileAttributes)0, File.GetAttributes(source) & FileAttributes.Hidden);
        File.SetAttributes(source, File.GetAttributes(source) | FileAttributes.Hidden);
        deleted = Assert.Single((await Run(Request("delete", source))).Items);
        await _operations.RestoreAsync(new() { RecoveryId = deleted.RecoveryId! }, Accessible, default);
        Assert.NotEqual((FileAttributes)0, File.GetAttributes(source) & FileAttributes.Hidden);
    }

    [UnixFact]
    [System.Runtime.Versioning.UnsupportedOSPlatform("windows")]
    public async Task UnixCopyRetainsPrivateModesAndRecoveryIsOwnerOnly()
    {
        var source = FileWith("private.txt"); var mode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        File.SetUnixFileMode(source, mode);
        var duplicate = Assert.Single((await Run(Request("duplicate", source))).Items); Assert.True(duplicate.Success);
        Assert.Equal(mode, File.GetUnixFileMode(duplicate.Path!));
        var deleted = Assert.Single((await Run(Request("delete", source))).Items); Assert.True(deleted.Success);
        Assert.Equal(mode | UnixFileMode.UserExecute, File.GetUnixFileMode(Path.Combine(_storage, "file-recovery")));
        await _operations.RestoreAsync(new() { RecoveryId = deleted.RecoveryId! }, Accessible, default);
        Assert.Equal(mode, File.GetUnixFileMode(source));
    }

    [Fact]
    public async Task RootBoundariesAndDestinationInsideSourceAreRejected()
    {
        string source = FileWith("folder/child.txt"), outside = Path.Combine(_base, "outside.txt"); File.WriteAllText(outside, "outside");
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() => Run(Request("delete", outside)));
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() => Run(Request("delete", _workspace)));
        var request = Request("copy", Path.GetDirectoryName(source)!); request.DestinationDirectory = Path.GetDirectoryName(source); request.Name = "nested";
        var item = Assert.Single((await Run(request)).Items); Assert.False(item.Success); Assert.Equal("recursive_destination", item.Code);
        Assert.True(File.Exists(source)); Assert.Equal("outside", await File.ReadAllTextAsync(outside));
    }

    [Theory]
    [InlineData("../escape")]
    [InlineData(".")]
    [InlineData("..")]
    [InlineData("")]
    public async Task InvalidNamesDoNotCreateEntries(string name)
    {
        var request = Request("createFile"); request.DestinationDirectory = _workspace; request.Name = name;
        await Assert.ThrowsAsync<FileDocumentException>(() => Run(request)); Assert.Empty(Directory.EnumerateFileSystemEntries(_workspace));
    }

    [Fact]
    public async Task ReadOnlyDeleteFailsWithoutMovingTheOriginal()
    {
        var path = FileWith("readonly.txt"); File.SetAttributes(path, File.GetAttributes(path) | FileAttributes.ReadOnly);
        var item = Assert.Single((await Run(Request("delete", path))).Items); Assert.False(item.Success); Assert.Equal("access_denied", item.Code);
        Assert.Equal("original 🎸\r\n", await File.ReadAllTextAsync(path)); Assert.Empty(_operations.ListRecovery(_workspace, null, Accessible).Entries);
    }

    [Fact]
    public async Task JunctionOperationsPreserveTheLinkAndNeverCopyOrDeleteItsExternalTarget()
    {
        var outside = Path.Combine(_base, "external"); Directory.CreateDirectory(outside); File.WriteAllText(Path.Combine(outside, "keep.txt"), "external");
        var link = Path.Combine(_workspace, "link");
        if (OperatingSystem.IsWindows())
        {
            var start = new ProcessStartInfo("pwsh") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            start.ArgumentList.Add("-NoProfile"); start.ArgumentList.Add("-Command");
            start.ArgumentList.Add("New-Item -ItemType Junction -Path $env:TLBX_OPS_LINK -Target $env:TLBX_OPS_TARGET | Out-Null");
            start.Environment["TLBX_OPS_LINK"] = link; start.Environment["TLBX_OPS_TARGET"] = outside;
            using var process = Process.Start(start)!; var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync(); await stdout; Assert.True(process.ExitCode == 0, await stderr);
        }
        else Directory.CreateSymbolicLink(link, outside);
        var duplicate = Assert.Single((await Run(Request("duplicate", link))).Items); Assert.True(duplicate.Success, duplicate.Message);
        Assert.NotNull(new DirectoryInfo(duplicate.Path!).LinkTarget);
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() => Run(Request("delete", Path.Combine(link, "keep.txt"))));
        var deleted = Assert.Single((await Run(Request("delete", link))).Items); Assert.True(deleted.Success, deleted.Message);
        Assert.False(Directory.Exists(link)); Assert.Equal("external", await File.ReadAllTextAsync(Path.Combine(outside, "keep.txt")));
        var restored = await _operations.RestoreAsync(new() { RecoveryId = deleted.RecoveryId! }, Accessible, default);
        Assert.True(restored.Success); Assert.NotNull(new DirectoryInfo(link).LinkTarget);
        Assert.Equal("external", await File.ReadAllTextAsync(Path.Combine(outside, "keep.txt")));
    }

    [UnixFact]
    public void NativeUnixRenameNeverOverwritesOrCopiesAcrossFilesystems()
    {
        var source = FileWith("native.txt"); var target = FileWith("occupied.txt", "occupied");
        var collision = Assert.Throws<FileDocumentException>(() => FileEntryMove.MoveUnix(source, target));
        Assert.Equal("name_conflict", collision.Code); Assert.Equal("occupied", File.ReadAllText(target));
        Assert.True(File.Exists(source));
        if (!OperatingSystem.IsLinux() || !Directory.Exists("/dev/shm")) return;
        var cross = Path.Combine("/dev/shm", "tlbx-native-" + Guid.NewGuid().ToString("N"));
        var error = Assert.Throws<IOException>(() => FileEntryMove.MoveUnix(source, cross));
        Assert.Equal(18, error.HResult & 0xFFFF); Assert.True(File.Exists(source)); Assert.False(File.Exists(cross));
    }

    [LinuxFact]
    public async Task LinuxCrossVolumeMoveRetainsARecoverableOriginalObject()
    {
        var destination = Path.Combine("/dev/shm", "tlbx-files-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(destination);
        try
        {
            var source = FileWith("volume.txt"); var alias = Path.Combine(_workspace, "original-hardlink.txt");
            Assert.Equal(0, NativeTestLink(source, alias));
            var request = Request("move", source); request.DestinationDirectory = destination;
            bool Allowed(string path) => Accessible(path) || FileService.IsWithinDirectory(path, destination);
            var moved = Assert.Single((await _operations.ExecuteAsync(request, Allowed, [_workspace, destination], default)).Items);
            Assert.True(moved.Success, moved.Message); Assert.False(File.Exists(source));
            Assert.Equal("original 🎸\r\n", File.ReadAllText(moved.Path!));
            var recovery = Assert.Single(_operations.ListRecovery(_workspace, null, Allowed).Entries);
            await _operations.RestoreAsync(new() { RecoveryId = recovery.Id }, Allowed, default);
            File.WriteAllText(alias, "same original inode"); Assert.Equal("same original inode", File.ReadAllText(source));
        }
        finally { PrepareFixtureCleanup(destination); Directory.Delete(destination, recursive: true); }
    }

    [LinuxFact]
    public async Task NestedRecoverySurvivesParentRenameDeleteAndRestart()
    {
        var storage = Path.Combine("/dev/shm", "tlbx-files-test-" + Guid.NewGuid().ToString("N"));
        var operations = new FileOperationService(storage);
        Directory.CreateDirectory(storage);
        try
        {
            var source = FileWith("parent/child.txt"); var parent = Path.GetDirectoryName(source)!;
            var child = Assert.Single((await operations.ExecuteAsync(Request("delete", source), Accessible, [_workspace], default)).Items);
            Assert.True(child.Success, child.Message);
            var rename = Request("rename", parent); rename.Name = "renamed";
            var renamed = Assert.Single((await operations.ExecuteAsync(rename, Accessible, [_workspace], default)).Items);
            Assert.True(renamed.Success, renamed.Message);
            var duplicate = Assert.Single((await operations.ExecuteAsync(Request("duplicate", renamed.Path!), Accessible, [_workspace], default)).Items);
            Assert.True(duplicate.Success, duplicate.Message); Assert.Empty(Directory.EnumerateFileSystemEntries(duplicate.Path!));
            var deleted = Assert.Single((await operations.ExecuteAsync(Request("delete", renamed.Path!), Accessible, [_workspace], default)).Items);
            Assert.True(deleted.Success, deleted.Message);
            operations = new(storage);
            var restoredChild = await operations.RestoreAsync(new() { RecoveryId = child.RecoveryId! }, Accessible, default);
            Assert.True(restoredChild.Success); Assert.Equal("original 🎸\r\n", File.ReadAllText(source));
            var restoredParent = await operations.RestoreAsync(new() { RecoveryId = deleted.RecoveryId! }, Accessible, default);
            Assert.True(restoredParent.Success); Assert.True(Directory.Exists(renamed.Path!));
        }
        finally { PrepareFixtureCleanup(storage); Directory.Delete(storage, recursive: true); }
    }

    [LinuxFact]
    public async Task ExternalGitMetadataOnAnotherVolumeSupportsCopyDeleteAndRestore()
    {
        var metadata = Path.Combine("/dev/shm", "tlbx-files-test-" + Guid.NewGuid().ToString("N"));
        var storage = Path.Combine("/dev/shm", "tlbx-files-test-" + Guid.NewGuid().ToString("N"));
        var operations = new FileOperationService(storage);
        Directory.CreateDirectory(storage);
        try
        {
            await GitAsync(_workspace, "init", "--separate-git-dir=" + metadata);
            var source = FileWith("external-git.txt");
            var copied = Assert.Single((await operations.ExecuteAsync(Request("duplicate", source), Accessible, [_workspace], default)).Items);
            Assert.True(copied.Success, copied.Message); Assert.Equal(File.ReadAllText(source), File.ReadAllText(copied.Path!));
            var deleted = Assert.Single((await operations.ExecuteAsync(Request("delete", source), Accessible, [_workspace], default)).Items);
            Assert.True(deleted.Success, deleted.Message);
            Assert.DoesNotContain("tlbx", await GitAsync(_workspace, "status", "--porcelain", "--untracked-files=all"), StringComparison.OrdinalIgnoreCase);
            var restored = await new FileOperationService(storage).RestoreAsync(new() { RecoveryId = deleted.RecoveryId! }, Accessible, default);
            Assert.True(restored.Success); Assert.Equal("original 🎸\r\n", File.ReadAllText(source));
        }
        finally
        {
            foreach (var path in new[] { metadata, storage })
                if (Directory.Exists(path)) { PrepareFixtureCleanup(path); Directory.Delete(path, recursive: true); }
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RecoveryCandidatePairWorksOnEitherSideOfTheNativeRename(bool moved)
    {
        var source = FileWith("crash.txt");
        var deleted = Assert.Single((await Run(Request("delete", source))).Items);
        var recordPath = Path.Combine(_storage, "file-recovery", "records", deleted.RecoveryId! + ".json");
        var record = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(recordPath))!;
        var stored = record["storedPath"]!.GetValue<string>();
        var candidate = Path.Combine(_base, "pending", "content"); Directory.CreateDirectory(Path.GetDirectoryName(candidate)!);
        if (moved) FileEntryCopy.Move(stored, candidate);
        else File.WriteAllText(candidate, "unrelated occupied candidate");
        record["pendingStoredPath"] = candidate; File.WriteAllText(recordPath, record.ToJsonString());
        await new FileOperationService(_storage).RestoreAsync(new() { RecoveryId = deleted.RecoveryId! }, Accessible, default);
        Assert.Equal("original 🎸\r\n", File.ReadAllText(source));
        if (!moved) Assert.Equal("unrelated occupied candidate", File.ReadAllText(candidate));
    }

    [System.Runtime.InteropServices.DllImport("libc", EntryPoint = "link", CharSet = System.Runtime.InteropServices.CharSet.Ansi)]
    [System.Diagnostics.CodeAnalysis.SuppressMessage("Security", "CA2101", Justification = "POSIX link requires UTF-8 paths and does not accept UTF-16.")]
    private static extern int NativeTestLink(
        [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPUTF8Str)] string source,
        [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPUTF8Str)] string target);

    [WindowsFact]
    public async Task WindowsLockedSourceDoesNotLoseAReplacedDestination()
    {
        string source = FileWith("source.txt", "new"), dest = Path.Combine(_workspace, "dest"); Directory.CreateDirectory(dest);
        var target = Path.Combine(dest, "source.txt"); File.WriteAllText(target, "old");
        using var held = new FileStream(source, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        var request = Request("copy", source); request.DestinationDirectory = dest; request.Conflict = "replace";
        var result = Assert.Single((await Run(request)).Items); Assert.False(result.Success); Assert.Equal("busy", result.Code);
        Assert.Equal("old", File.ReadAllText(target)); Assert.Empty(Directory.EnumerateFileSystemEntries(_workspace, ".tlbx-ops-*"));
    }

    public void Dispose()
    {
        var full = Path.GetFullPath(_base);
        if (!FileService.IsWithinDirectory(full, Path.GetTempPath()) || !Path.GetFileName(full).StartsWith("file_operations_test_", StringComparison.Ordinal))
            throw new InvalidOperationException("Unexpected file operation fixture.");
        PrepareFixtureCleanup(full); Directory.Delete(full, recursive: true); GC.SuppressFinalize(this);
    }

    private static void PrepareFixtureCleanup(string path)
    {
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
        {
            if ((attributes & FileAttributes.Directory) != 0) Directory.Delete(path, recursive: false);
            else File.Delete(path);
            return;
        }
        if ((attributes & FileAttributes.Directory) != 0)
            foreach (var child in Directory.EnumerateFileSystemEntries(path)) PrepareFixtureCleanup(child);
        File.SetAttributes(path, attributes & ~FileAttributes.ReadOnly);
    }
}

internal sealed class WindowsFactAttribute : FactAttribute
{
    public WindowsFactAttribute() { if (!OperatingSystem.IsWindows()) Skip = "Windows filesystem semantics."; }
}
internal sealed class UnixFactAttribute : FactAttribute
{
    public UnixFactAttribute() { if (OperatingSystem.IsWindows()) Skip = "Unix permission modes."; }
}
internal sealed class LinuxFactAttribute : FactAttribute
{
    public LinuxFactAttribute() { if (!OperatingSystem.IsLinux() || !Directory.Exists("/dev/shm")) Skip = "Requires Linux with a separate tmpfs volume."; }
}
internal sealed class CrossVolumeWindowsFactAttribute : FactAttribute
{
    public CrossVolumeWindowsFactAttribute()
    {
        if (!OperatingSystem.IsWindows() || !Directory.Exists("Q:\\repos\\tlbx-2\\.dev\\file-git-production"))
            Skip = "Requires the local Q: second-volume fixture lane.";
    }
}
