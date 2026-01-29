namespace Ai.Tlbx.MidTerm.Models;

public sealed class LogSubscribeMessage
{
    public string Action { get; init; } = "";    // "subscribe" | "unsubscribe" | "history"
    public string Type { get; init; } = "";      // "mt" | "mthost"
    public string? SessionId { get; init; }      // For mthost logs
    public int? Limit { get; init; }             // For history requests
}

public sealed class LogEntryMessage
{
    public string MessageType { get; init; } = "log";
    public string Source { get; init; } = "";    // "mt" | "mthost"
    public string? SessionId { get; init; }
    public string Timestamp { get; init; } = "";
    public string Level { get; init; } = "";
    public string Message { get; init; } = "";
}

public sealed class LogHistoryMessage
{
    public string MessageType { get; init; } = "history";
    public string Source { get; init; } = "";
    public string? SessionId { get; init; }
    public List<LogEntryMessage> Entries { get; init; } = [];
    public bool HasMore { get; init; }
}

public sealed class LogSessionsMessage
{
    public string MessageType { get; init; } = "sessions";
    public List<LogSessionInfo> Sessions { get; init; } = [];
}

public sealed class LogSessionInfo
{
    public string Id { get; init; } = "";
    public bool Active { get; init; }
    public int LogCount { get; init; }
}

public sealed class LogFilesResponse
{
    public List<LogFileInfo> Files { get; init; } = [];
}

public sealed class LogFileInfo
{
    public string Name { get; init; } = "";
    public string Source { get; init; } = "";
    public string? SessionId { get; init; }
    public long Size { get; init; }
    public string Modified { get; init; } = "";
    public bool IsActive { get; init; }
}

public sealed class LogReadResponse
{
    public List<LogEntryMessage> Entries { get; init; } = [];
    public long Position { get; init; }
    public string FileName { get; init; } = "";
}
