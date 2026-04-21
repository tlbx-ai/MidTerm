using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

internal sealed record SessionLaunchFailure(
    string Stage,
    string Message,
    string? Detail = null,
    string? ExceptionType = null,
    int? NativeErrorCode = null);

internal sealed record SessionCreationResult(SessionInfo? Session, SessionLaunchFailure? Failure)
{
    public bool Succeeded => Session is not null;

    public static SessionCreationResult Success(SessionInfo session) => new(session, null);

    public static SessionCreationResult Failed(SessionLaunchFailure failure) => new(null, failure);
}

internal sealed record TtyHostSpawnResult(int ProcessId, SessionLaunchFailure? Failure)
{
    public bool Succeeded => Failure is null;

    public static TtyHostSpawnResult Success(int processId) => new(processId, null);

    public static TtyHostSpawnResult Failed(
        string message,
        string? detail = null,
        string? exceptionType = null,
        int? nativeErrorCode = null,
        string stage = "spawn") =>
        new(0, new SessionLaunchFailure(stage, message, detail, exceptionType, nativeErrorCode));
}
