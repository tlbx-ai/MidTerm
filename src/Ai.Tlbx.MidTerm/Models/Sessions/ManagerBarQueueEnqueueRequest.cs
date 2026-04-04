using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class ManagerBarQueueEnqueueRequest
{
    public string SessionId { get; set; } = string.Empty;
    public ManagerBarButton? Action { get; set; }
}
