using System.Collections.Concurrent;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public sealed class WorkerSessionRegistryService
{
    private readonly ConcurrentDictionary<string, WorkerSessionRegistration> _registrations = new(StringComparer.Ordinal);

    public void Register(
        string sessionId,
        string profile,
        string? launchCommand,
        IEnumerable<string> slashCommands,
        int launchDelayMs,
        int slashCommandDelayMs)
    {
        _registrations[sessionId] = new WorkerSessionRegistration(
            sessionId,
            profile,
            launchCommand,
            slashCommands.Where(static command => !string.IsNullOrWhiteSpace(command)).ToArray(),
            launchDelayMs,
            slashCommandDelayMs);
    }

    public bool TryGet(string sessionId, out WorkerSessionRegistration registration)
    {
        return _registrations.TryGetValue(sessionId, out registration!);
    }

    public void Forget(string sessionId)
    {
        _registrations.TryRemove(sessionId, out _);
    }
}

public sealed record WorkerSessionRegistration(
    string SessionId,
    string Profile,
    string? LaunchCommand,
    IReadOnlyList<string> SlashCommands,
    int LaunchDelayMs,
    int SlashCommandDelayMs);
