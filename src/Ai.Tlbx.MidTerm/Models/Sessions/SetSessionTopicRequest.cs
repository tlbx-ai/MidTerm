using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class SetSessionTopicRequest
{
    [JsonRequired]
    public string? Topic { get; init; }
}
