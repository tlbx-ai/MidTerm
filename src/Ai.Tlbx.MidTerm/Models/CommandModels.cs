namespace Ai.Tlbx.MidTerm.Models;

public sealed class CommandDefinition
{
    public string Filename { get; set; } = "";
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public string[] Commands { get; set; } = [];
    public int Order { get; set; }
}

public sealed class CommandListResponse
{
    public string CommandsDirectory { get; set; } = "";
    public CommandDefinition[] Commands { get; set; } = [];
}

public sealed class CreateCommandRequest
{
    public string SessionId { get; set; } = "";
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public string[] Commands { get; set; } = [];
}

public sealed class UpdateCommandRequest
{
    public string SessionId { get; set; } = "";
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public string[] Commands { get; set; } = [];
}

public sealed class RunCommandRequest
{
    public string SessionId { get; set; } = "";
    public string Filename { get; set; } = "";
}

public sealed class ReorderCommandsRequest
{
    public string SessionId { get; set; } = "";
    public string[] Filenames { get; set; } = [];
}

public sealed class CommandRunStatus
{
    public string RunId { get; set; } = "";
    public string Status { get; set; } = "";
    public int? ExitCode { get; set; }
    public int CurrentStep { get; set; }
    public int TotalSteps { get; set; }
}
