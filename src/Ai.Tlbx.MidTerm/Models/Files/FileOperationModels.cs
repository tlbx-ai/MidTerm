namespace Ai.Tlbx.MidTerm.Models.Files;

public sealed class FileOperationRequest
{
    public string RequestId { get; set; } = string.Empty;
    public string Action { get; set; } = string.Empty;
    public string[] Paths { get; set; } = [];
    public string? DestinationDirectory { get; set; }
    public string? Name { get; set; }
    public string Conflict { get; set; } = "fail";
}

public sealed class FileOperationResponse
{
    public string OperationId { get; set; } = string.Empty;
    public string Action { get; set; } = string.Empty;
    public bool Complete { get; set; }
    public FileOperationItem[] Items { get; set; } = [];
}

public sealed class FileOperationItem
{
    public string? SourcePath { get; set; }
    public string? Path { get; set; }
    public bool Success { get; set; }
    public string? Code { get; set; }
    public string? Message { get; set; }
    public string? RecoveryId { get; set; }
}

public sealed class FileRecoveryEntry
{
    public string Id { get; set; } = string.Empty;
    public string OriginalPath { get; set; } = string.Empty;
    public string Kind { get; set; } = string.Empty;
    public DateTimeOffset CreatedAt { get; set; }
    public bool IsDirectory { get; set; }
    public bool IsLink { get; set; }
}

public sealed class FileRecoveryResponse
{
    public FileRecoveryEntry[] Entries { get; set; } = [];
    public string? NextCursor { get; set; }
}

public sealed class FileRestoreRequest
{
    public string RecoveryId { get; set; } = string.Empty;
    public string Conflict { get; set; } = "fail";
}
