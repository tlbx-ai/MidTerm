namespace Ai.Tlbx.MidTerm.Services.Sessions;

public sealed class SessionLensHeatSnapshot
{
    public static SessionLensHeatSnapshot Cold { get; } = new();

    public double CurrentHeat { get; init; }
    public DateTimeOffset? LastActivityAt { get; init; }
}
