namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class AgentSessionVibeResponse
{
    public string SessionId { get; set; } = string.Empty;
    public string Source { get; set; } = "fallback";
    public DateTimeOffset GeneratedAt { get; set; }
    public AgentSessionVibeHeader Header { get; set; } = new();
    public AgentSessionVibeLane Lane { get; set; } = new();
    public List<AgentSessionVibeCapability> Capabilities { get; set; } = [];
    public AgentSessionVibeOverview Overview { get; set; } = new();
    public List<AgentSessionVibeActivity> Activities { get; set; } = [];
    public List<SessionActivityHeatSample> Heatmap { get; set; } = [];
    public AgentSessionVibeTerminal Terminal { get; set; } = new();
}

public sealed class AgentSessionVibeHeader
{
    public string Title { get; set; } = string.Empty;
    public string Subtitle { get; set; } = string.Empty;
    public string Provider { get; set; } = string.Empty;
    public string ProviderLabel { get; set; } = string.Empty;
    public string State { get; set; } = string.Empty;
    public string StateLabel { get; set; } = string.Empty;
    public bool NeedsAttention { get; set; }
    public string? AttentionReason { get; set; }
    public string TransportSummary { get; set; } = string.Empty;
    public List<AgentSessionVibeChip> Chips { get; set; } = [];
}

public sealed class AgentSessionVibeChip
{
    public string Text { get; set; } = string.Empty;
    public string Tone { get; set; } = string.Empty;
}

public sealed class AgentSessionVibeLane
{
    public string Mode { get; set; } = "fallback";
    public string Tone { get; set; } = "fallback";
    public string Label { get; set; } = string.Empty;
    public string Detail { get; set; } = string.Empty;
}

public sealed class AgentSessionVibeCapability
{
    public string Key { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public string StatusLabel { get; set; } = string.Empty;
    public string Detail { get; set; } = string.Empty;
}

public sealed class AgentSessionVibeOverview
{
    public string StateValue { get; set; } = string.Empty;
    public string StateMeta { get; set; } = string.Empty;
    public string ActivityValue { get; set; } = string.Empty;
    public string ActivityMeta { get; set; } = string.Empty;
    public string LastOutputValue { get; set; } = string.Empty;
    public string LastOutputMeta { get; set; } = string.Empty;
    public string BellsValue { get; set; } = string.Empty;
    public string BellsMeta { get; set; } = string.Empty;
}

public sealed class AgentSessionVibeActivity
{
    public string Id { get; set; } = string.Empty;
    public string Tone { get; set; } = string.Empty;
    public string Kind { get; set; } = string.Empty;
    public string Summary { get; set; } = string.Empty;
    public string? Detail { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class AgentSessionVibeTerminal
{
    public int TailLineCount { get; set; }
    public string TailText { get; set; } = string.Empty;
    public string EmptyMessage { get; set; } = string.Empty;
}
