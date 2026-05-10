namespace Ai.Tlbx.MidTerm.Services.Sessions;

public sealed class SessionAppServerControlHeatSnapshot
{
    public static SessionAppServerControlHeatSnapshot Cold { get; } = new();

    public double CurrentHeat { get; init; }
    public DateTimeOffset? LastActivityAt { get; init; }
}
