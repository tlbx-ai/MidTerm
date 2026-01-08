namespace Ai.Tlbx.MidTerm.Common.Logging;

public sealed class LogRotationPolicy
{
    public long MaxFileSizeBytes { get; init; } = 10 * 1024 * 1024;
    public int MaxFileCount { get; init; } = 5;
    public long MaxDirectorySizeBytes { get; init; } = 100 * 1024 * 1024;

    public static LogRotationPolicy Default { get; } = new();
}
