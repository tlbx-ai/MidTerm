using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Models.Files;

/// <summary>
/// Request to check if multiple file paths exist.
/// </summary>
public sealed class FileCheckRequest
{
    public string[] Paths { get; set; } = [];
}

/// <summary>
/// Response containing existence info for each requested path.
/// </summary>
public sealed class FileCheckResponse
{
    public Dictionary<string, FilePathInfo> Results { get; set; } = new(StringComparer.Ordinal);
}

/// <summary>
/// Information about a file or directory path.
/// </summary>
public sealed class FilePathInfo
{
    public bool Exists { get; set; }
    public long? Size { get; set; }
    public bool IsDirectory { get; set; }
    public string? MimeType { get; set; }
    public DateTime? Modified { get; set; }
    public bool? IsText { get; set; }
}

/// <summary>
/// Response containing directory listing.
/// </summary>
public sealed class DirectoryListResponse
{
    public string Path { get; set; } = string.Empty;
    public DirectoryEntry[] Entries { get; set; } = [];
}

public sealed class FileNavigationResponse
{
    public string Path { get; set; } = string.Empty;
    public string? ParentPath { get; set; }
    public bool Exists { get; set; }
    public bool IsDirectory { get; set; }
    public string? WorkingDirectory { get; set; }
    public FileNavigationLocation[] Breadcrumbs { get; set; } = [];
    public FileNavigationRoot[] Roots { get; set; } = [];
    public FileTreeEntry? File { get; set; }
}

public sealed class FileNavigationLocation
{
    public string Path { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
}

public sealed class FileNavigationRoot
{
    public string Path { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Kind { get; set; } = string.Empty;
}

/// <summary>
/// A single entry in a directory listing.
/// </summary>
public sealed class DirectoryEntry
{
    public string Name { get; set; } = string.Empty;
    public bool IsDirectory { get; set; }
    public long? Size { get; set; }
    public DateTime? Modified { get; set; }
    public string? MimeType { get; set; }
}

/// <summary>
/// Request to register detected file paths for File Radar security allowlist.
/// </summary>
public sealed class FileRegisterRequest
{
    public string SessionId { get; set; } = string.Empty;
    public string[] Paths { get; set; } = [];
}

/// <summary>
/// Response for resolving a relative path against session's working directory.
/// Used for lazy file existence checks on hover.
/// </summary>
public sealed class FileResolveResponse
{
    public bool Exists { get; set; }
    public string? ResolvedPath { get; set; }
    public bool IsDirectory { get; set; }
    public long? Size { get; set; }
    public string? MimeType { get; set; }
    public DateTime? Modified { get; set; }
    public bool? IsText { get; set; }
}

public sealed class FileTreeResponse
{
    public string Path { get; set; } = string.Empty;
    public FileTreeEntry[] Entries { get; set; } = [];
    public bool IsGitRepo { get; set; }
}

public sealed class FileTreeEntry
{
    public string Name { get; set; } = string.Empty;
    public string FullPath { get; set; } = string.Empty;
    public bool IsDirectory { get; set; }
    public long? Size { get; set; }
    public string? MimeType { get; set; }
    public bool? IsText { get; set; }
    public string? GitStatus { get; set; }
}

public sealed class FileSaveRequest
{
    [JsonRequired]
    public string Path { get; set; } = string.Empty;

    [JsonRequired]
    public string Content { get; set; } = string.Empty;

    [JsonRequired]
    public string ExpectedVersion { get; set; } = string.Empty;
}

public sealed class FileSaveResponse
{
    public bool Success { get; set; }
    public long Size { get; set; }
    public string Version { get; set; } = string.Empty;
    public string Encoding { get; set; } = string.Empty;
    public string LineEnding { get; set; } = string.Empty;
}

public sealed class FileDocumentResponse
{
    public string Path { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
    public string? Version { get; set; }
    public long Size { get; set; }
    public string Encoding { get; set; } = string.Empty;
    public string LineEnding { get; set; } = string.Empty;
    public bool IsTruncated { get; set; }
    public bool CanLoadFull { get; set; }
    public bool ReadOnly { get; set; }
    public long Offset { get; set; }
    public long NextOffset { get; set; }
    public long PreviewBytes { get; set; }
    public long EditLimitBytes { get; set; }
}

public sealed class FileDocumentErrorResponse
{
    public string Code { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
    public string? CurrentVersion { get; set; }
    public string? RecoveryPath { get; set; }
}

public sealed class LauncherPathResponse
{
    public string Path { get; set; } = string.Empty;
    public string HomePath { get; set; } = string.Empty;
    public string StartPath { get; set; } = string.Empty;
}

public sealed class LauncherDirectoryEntry
{
    public string Name { get; set; } = string.Empty;
    public string FullPath { get; set; } = string.Empty;
    public bool IsRoot { get; set; }
}

public sealed class LauncherDirectoryListResponse
{
    public string Path { get; set; } = string.Empty;
    public string? ParentPath { get; set; }
    public LauncherDirectoryEntry[] Entries { get; set; } = [];
}

public sealed class LauncherDirectoryAccessResponse
{
    public string Path { get; set; } = string.Empty;
    public bool CanWrite { get; set; }
}

public sealed class LauncherCreateDirectoryRequest
{
    public string ParentPath { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
}

public sealed class LauncherCloneRepositoryRequest
{
    public string ParentPath { get; set; } = string.Empty;
    public string RepositoryUrl { get; set; } = string.Empty;
}

public sealed class LauncherDirectoryMutationResponse
{
    public string Path { get; set; } = string.Empty;
}
