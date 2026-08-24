namespace Ai.Tlbx.MidTerm.Models.Browser;

public sealed class AgentHistoryWheelRequest
{
    public string SessionId { get; init; } = "";
    public double? DeltaY { get; init; }
    public int? Steps { get; init; }
}

public sealed class AgentHistoryWheelResult
{
    public string RequestId { get; init; } = "";
    public bool Success { get; init; }
    public string? Error { get; init; }
    public string SessionId { get; init; } = "";
    public int CancelledSteps { get; init; }
    public AgentHistoryScrollMetrics? Before { get; init; }
    public AgentHistoryScrollMetrics? After { get; init; }
    public List<AgentHistoryScrollMetrics> Samples { get; init; } = [];
}

public sealed class AgentHistoryScrollMetrics
{
    public double ScrollTop { get; init; }
    public double ScrollHeight { get; init; }
    public double ClientHeight { get; init; }
    public bool AtTop { get; init; }
    public bool AtBottom { get; init; }
    public double Progress { get; init; }
    public int NavigatorValue { get; init; }
    public int NavigatorMaximum { get; init; }
}
