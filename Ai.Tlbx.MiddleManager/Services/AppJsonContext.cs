using System.Text.Json.Serialization;
using Ai.Tlbx.MiddleManager.Models;
using Ai.Tlbx.MiddleManager.Settings;

namespace Ai.Tlbx.MiddleManager.Services;

[JsonSerializable(typeof(SessionListDto))]
[JsonSerializable(typeof(SessionInfoDto))]
[JsonSerializable(typeof(CreateSessionRequest))]
[JsonSerializable(typeof(RenameSessionRequest))]
[JsonSerializable(typeof(ResizeRequest))]
[JsonSerializable(typeof(ResizeResponse))]
[JsonSerializable(typeof(List<NetworkInterfaceDto>))]
[JsonSerializable(typeof(ShellInfoDto))]
[JsonSerializable(typeof(List<ShellInfoDto>))]
[JsonSerializable(typeof(MiddleManagerSettings))]
[JsonSerializable(typeof(UpdateInfo))]
[JsonSerializable(typeof(UpdateType))]
[JsonSerializable(typeof(VersionManifest))]
[JsonSerializable(typeof(StateUpdate))]
[JsonSerializable(typeof(SystemHealth))]
[JsonSerializable(typeof(UserInfo))]
[JsonSerializable(typeof(List<UserInfo>))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, UseStringEnumConverter = true)]
public partial class AppJsonContext : JsonSerializerContext
{
}

public sealed class StateUpdate
{
    public SessionListDto? Sessions { get; init; }
    public UpdateInfo? Update { get; init; }
    public bool HostConnected { get; init; }
}

public sealed class SystemHealth
{
    public bool Healthy { get; init; }
    public string Mode { get; init; } = "";
    public bool HostConnected { get; init; }
    public string? HostError { get; init; }
    public int SessionCount { get; init; }
    public string Version { get; init; } = "";
}
