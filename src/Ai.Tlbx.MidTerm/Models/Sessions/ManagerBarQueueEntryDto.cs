using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class ManagerBarQueueEntryDto
{
    public string QueueId { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public ManagerBarButton Action { get; set; } = new();
    public string Phase { get; set; } = "pendingImmediate";
    public int NextPromptIndex { get; set; }
    public int CompletedCycles { get; set; }
    public DateTimeOffset? NextRunAt { get; set; }
    public DateTimeOffset? IgnoreHeatUntil { get; set; }
    public bool AwaitingHeatRise { get; set; }
}
