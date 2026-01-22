namespace Ai.Tlbx.MidTerm.Models;

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
    public Dictionary<string, FilePathInfo> Results { get; set; } = new();
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
}

/// <summary>
/// Response containing directory listing.
/// </summary>
public sealed class DirectoryListResponse
{
    public string Path { get; set; } = string.Empty;
    public DirectoryEntry[] Entries { get; set; } = [];
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
}
