using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Models.ActionGraphs;

/// <summary>
/// Well-known node kinds. The set is advisory: unknown kinds are accepted and rendered
/// like <see cref="Identity"/>, because the graph is a canvas — meaning belongs to the
/// agent instructions that fill it, not to tlbx.
/// </summary>
public static class ActionGraphNodeKinds
{
    public const string Email = "email";
    public const string Appointment = "appointment";
    public const string Todo = "todo";
    public const string Project = "project";
    public const string Task = "task";
    public const string Asset = "asset";
    public const string Plan = "plan";
    public const string Note = "note";
    public const string Repo = "repo";
    public const string Place = "place";
    public const string Server = "server";
    public const string Application = "application";
    public const string Service = "service";
    public const string Secret = "secret";
    public const string Identity = "identity";
    public const string Frame = "frame";

    public static readonly HashSet<string> Known = new(StringComparer.Ordinal)
    {
        Email, Appointment, Todo, Project, Task, Asset, Plan, Note,
        Repo, Place, Server, Application, Service, Secret, Identity, Frame
    };
}

/// <summary>
/// An action stored on a node. tlbx executes the launch spec verbatim
/// (bootstrap session + state-aware prompt); it never interprets it.
/// </summary>
public sealed class ActionGraphNodeAction
{
    public string Id { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public string? Cwd { get; set; }
    public string? Profile { get; set; }
    public string? Prompt { get; set; }
    public string? SessionName { get; set; }
    public List<string> SlashCommands { get; set; } = [];
}

public sealed class ActionGraphNode
{
    public string Id { get; set; } = string.Empty;
    public string Kind { get; set; } = ActionGraphNodeKinds.Identity;
    public string Title { get; set; } = string.Empty;
    public string? State { get; set; }

    /// <summary>Rich HTML body. Rendered sandboxed in the UI; stored verbatim.</summary>
    public string? Html { get; set; }

    public double X { get; set; }
    public double Y { get; set; }
    public double? Width { get; set; }
    public double? Height { get; set; }
    public string? Color { get; set; }

    public string? Url { get; set; }
    public string? Path { get; set; }
    public string? Host { get; set; }
    public string? Project { get; set; }
    public string? SessionId { get; set; }
    public string? ExternalRef { get; set; }
    public DateTimeOffset? Date { get; set; }

    public List<ActionGraphNodeAction> Actions { get; set; } = [];
    public string Source { get; set; } = "agent";
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public int Revision { get; set; }
}

public sealed class ActionGraphEdge
{
    public string Id { get; set; } = string.Empty;
    public string FromId { get; set; } = string.Empty;
    public string ToId { get; set; } = string.Empty;
    public string? Label { get; set; }
    public string? Kind { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// Scopes partition graphs (work, leisure, ...). Most users stay in the built-in
/// default scope; the UI keeps scope controls quiet until more than one exists.
/// </summary>
public sealed class ActionGraphScope
{
    public const string DefaultId = "default";

    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public int GraphCount { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class ActionGraphScopeListResponse
{
    public List<ActionGraphScope> Scopes { get; set; } = [];
}

public sealed class CreateActionGraphScopeRequest
{
    public string? Id { get; set; }
    public string? Name { get; set; }
}

public sealed class RenameActionGraphScopeRequest
{
    public string? Name { get; set; }
}

public sealed class ActionGraph
{
    public string Id { get; set; } = string.Empty;
    public string ScopeId { get; set; } = ActionGraphScope.DefaultId;
    public string Name { get; set; } = string.Empty;
    public List<ActionGraphNode> Nodes { get; set; } = [];
    public List<ActionGraphEdge> Edges { get; set; } = [];

    // Stored refresh spec: the UI launches this verbatim in a visible session —
    // a free-form agent launch command (not a profile), cwd, and the prompt.
    public string? RefreshCommand { get; set; }
    public string? RefreshCwd { get; set; }
    public string? RefreshPrompt { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed class ActionGraphsDocument
{
    public List<ActionGraph> Graphs { get; set; } = [];
}

public sealed class ActionGraphSummary
{
    public string Id { get; set; } = string.Empty;
    public string ScopeId { get; set; } = ActionGraphScope.DefaultId;
    public string Name { get; set; } = string.Empty;
    public int NodeCount { get; set; }
    public int EdgeCount { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed class ActionGraphListResponse
{
    public List<ActionGraphSummary> Graphs { get; set; } = [];
}

public sealed class CreateActionGraphRequest
{
    public string? Id { get; set; }
    public string? Name { get; set; }
    public string? ScopeId { get; set; }
    public string? RefreshCommand { get; set; }
    public string? RefreshCwd { get; set; }
    public string? RefreshPrompt { get; set; }
}

public sealed class UpsertActionGraphNodeRequest
{
    public string? Id { get; set; }
    public string? Kind { get; set; }
    public string? Title { get; set; }
    public string? State { get; set; }
    public string? Html { get; set; }
    public double? X { get; set; }
    public double? Y { get; set; }
    public double? Width { get; set; }
    public double? Height { get; set; }
    public string? Color { get; set; }
    public string? Url { get; set; }
    public string? Path { get; set; }
    public string? Host { get; set; }
    public string? Project { get; set; }
    public string? SessionId { get; set; }
    public string? ExternalRef { get; set; }
    public DateTimeOffset? Date { get; set; }
    public List<ActionGraphNodeAction>? Actions { get; set; }
    public string? Source { get; set; }
}

public sealed class SetActionGraphNodePositionRequest
{
    public double X { get; set; }
    public double Y { get; set; }
}

public sealed class CreateActionGraphEdgeRequest
{
    public string? Id { get; set; }
    public string? FromId { get; set; }
    public string? ToId { get; set; }
    public string? Label { get; set; }
    public string? Kind { get; set; }
}

[JsonSerializable(typeof(ActionGraphsDocument))]
[JsonSerializable(typeof(ActionGraph))]
[JsonSerializable(typeof(ActionGraphNode))]
[JsonSerializable(typeof(ActionGraphEdge))]
[JsonSerializable(typeof(List<string>))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = true)]
public partial class ActionGraphsJsonContext : JsonSerializerContext
{
}
