using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class SetSessionNotesRequest
{
    [JsonRequired]
    public string? Notes { get; init; }
}
