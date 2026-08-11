namespace Ai.Tlbx.MidTerm.Models.Update;

/// <summary>
/// Result of an update operation.
/// </summary>
public sealed class UpdateResult
{
    public bool Found { get; set; }
    public bool Success { get; set; }
    public string Message { get; set; } = "";
    public string Details { get; set; } = "";
    public string Timestamp { get; set; } = "";
    public string LogFile { get; set; } = "";
    public bool RollbackAttempted { get; set; }
}
