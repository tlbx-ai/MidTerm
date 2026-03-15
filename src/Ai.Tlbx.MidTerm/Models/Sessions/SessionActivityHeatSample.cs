namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class SessionActivityHeatSample
{
    public DateTimeOffset Timestamp { get; set; }
    public int Bytes { get; set; }
    public double Heat { get; set; }
}
