namespace Ai.Tlbx.MidTerm.Api.Models;

public sealed class WsCommand
{
    public string Command { get; init; } = "";
    public WsCommandPayload? Payload { get; init; }
}

public sealed class WsCommandPayload
{
    public int? Cols { get; init; }
    public int? Rows { get; init; }
    public string? Shell { get; init; }
    public string? WorkingDirectory { get; init; }
    public string? Name { get; init; }
}

public sealed class WsCommandResponse
{
    public string Command { get; init; } = "";
    public string? Error { get; init; }
    public WsSessionCreatedData? Data { get; init; }
}

public sealed class WsSessionCreatedData
{
    public string Id { get; init; } = "";
}

