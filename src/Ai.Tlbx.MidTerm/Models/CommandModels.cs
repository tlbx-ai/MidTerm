namespace Ai.Tlbx.MidTerm.Models;

public sealed class ScriptDefinition
{
    public string Filename { get; set; } = "";
    public string Name { get; set; } = "";
    public string Extension { get; set; } = "";
    public string ShellType { get; set; } = "";
    public string Content { get; set; } = "";
}

public sealed class ScriptListResponse
{
    public string ScriptsDirectory { get; set; } = "";
    public ScriptDefinition[] Scripts { get; set; } = [];
}

public sealed class CreateScriptRequest
{
    public string SessionId { get; set; } = "";
    public string Name { get; set; } = "";
    public string Extension { get; set; } = "";
    public string Content { get; set; } = "";
}

public sealed class UpdateScriptRequest
{
    public string SessionId { get; set; } = "";
    public string Content { get; set; } = "";
}

public sealed class RunScriptRequest
{
    public string SessionId { get; set; } = "";
    public string Filename { get; set; } = "";
}

public sealed class RunScriptResponse
{
    public string HiddenSessionId { get; set; } = "";
}

public sealed class StopScriptRequest
{
    public string HiddenSessionId { get; set; } = "";
}
