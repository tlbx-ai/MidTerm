using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Voice.WebSockets;

/// <summary>
/// Source-generated JSON context for AOT-safe serialization of voice WebSocket messages.
/// </summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    WriteIndented = false)]
[JsonSerializable(typeof(VoiceControlMessage))]
public partial class VoiceJsonContext : JsonSerializerContext
{
}
