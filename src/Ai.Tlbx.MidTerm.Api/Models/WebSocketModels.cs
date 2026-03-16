namespace Ai.Tlbx.MidTerm.Api.Models;

public sealed class WsCommand
{
    public string Type { get; init; } = "";
    public string Id { get; init; } = "";
    public string Action { get; init; } = "";
    public WsCommandPayload? Payload { get; init; }
}

public sealed class WsCommandPayload
{
    public int? Cols { get; init; }
    public int? Rows { get; init; }
    public string? Shell { get; init; }
    public string? WorkingDirectory { get; init; }
    public string? SessionId { get; init; }
    public string? Name { get; init; }
    public bool? Auto { get; init; }
    public List<string>? SessionIds { get; init; }
}

public sealed class WsCommandResponse
{
    public string Type { get; init; } = "response";
    public string Id { get; init; } = "";
    public bool Success { get; init; }
    public string? Error { get; init; }
    public object? Data { get; init; }
}

public sealed class WsSessionCreatedData
{
    public string Id { get; init; } = "";
    public int Pid { get; init; }
    public string ShellType { get; init; } = "";
}
