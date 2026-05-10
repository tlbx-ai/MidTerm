using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class ManagerBarQueueEntryDto
{
    public string QueueId { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public string Kind { get; set; } = "automation";
    public ManagerBarButton? Action { get; set; }
    public AppServerControlTurnRequest? Turn { get; set; }
    public string Phase { get; set; } = "pendingImmediate";
    public int NextPromptIndex { get; set; }
    public int CompletedCycles { get; set; }
    public DateTimeOffset? NextRunAt { get; set; }
    public DateTimeOffset? IgnoreHeatUntil { get; set; }
    public bool AwaitingHeatRise { get; set; }
}
