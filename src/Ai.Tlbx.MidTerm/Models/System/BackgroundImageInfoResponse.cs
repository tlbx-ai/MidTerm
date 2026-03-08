namespace Ai.Tlbx.MidTerm.Models.System;

public sealed class BackgroundImageInfoResponse
{
    public bool HasImage { get; init; }
    public string? FileName { get; init; }
    public long Revision { get; init; }
}
