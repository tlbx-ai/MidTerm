namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class SessionActivityResponse
{
    public string SessionId { get; set; } = "";
    public int WindowSeconds { get; set; }
    public int BellLimit { get; set; }
    public long TotalOutputBytes { get; set; }
    public int TotalBellCount { get; set; }
    public int CurrentBytesPerSecond { get; set; }
    public double CurrentHeat { get; set; }
    public DateTimeOffset? LastOutputAt { get; set; }
    public DateTimeOffset? LastBellAt { get; set; }
    public List<SessionActivityHeatSample> Heatmap { get; set; } = [];
    public List<SessionBellEvent> BellHistory { get; set; } = [];
}
