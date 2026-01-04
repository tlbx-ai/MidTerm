using System.Text.Json.Serialization;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Mvc;

namespace Ai.Tlbx.MidTerm.Services;

[JsonSerializable(typeof(ProblemDetails))]
[JsonSerializable(typeof(SessionListDto))]
[JsonSerializable(typeof(SessionInfoDto))]
[JsonSerializable(typeof(CreateSessionRequest))]
[JsonSerializable(typeof(RenameSessionRequest))]
[JsonSerializable(typeof(ResizeRequest))]
[JsonSerializable(typeof(ResizeResponse))]
[JsonSerializable(typeof(FileUploadResponse))]
[JsonSerializable(typeof(List<NetworkInterfaceDto>))]
[JsonSerializable(typeof(ShellInfoDto))]
[JsonSerializable(typeof(List<ShellInfoDto>))]
[JsonSerializable(typeof(MidTermSettings))]
[JsonSerializable(typeof(UpdateInfo))]
[JsonSerializable(typeof(UpdateType))]
[JsonSerializable(typeof(UpdateResult))]
[JsonSerializable(typeof(VersionManifest))]
[JsonSerializable(typeof(StateUpdate))]
[JsonSerializable(typeof(SystemHealth))]
[JsonSerializable(typeof(UserInfo))]
[JsonSerializable(typeof(List<UserInfo>))]
[JsonSerializable(typeof(LoginRequest))]
[JsonSerializable(typeof(ChangePasswordRequest))]
[JsonSerializable(typeof(AuthResponse))]
[JsonSerializable(typeof(AuthStatusResponse))]
[JsonSerializable(typeof(CursorStyleSetting))]
[JsonSerializable(typeof(ThemeSetting))]
[JsonSerializable(typeof(BellStyleSetting))]
[JsonSerializable(typeof(ClipboardShortcutsSetting))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, UseStringEnumConverter = true)]
public partial class AppJsonContext : JsonSerializerContext
{
}

public sealed class LoginRequest
{
    public string Password { get; init; } = "";
}

public sealed class ChangePasswordRequest
{
    public string? CurrentPassword { get; init; }
    public string NewPassword { get; init; } = "";
}

public sealed class AuthResponse
{
    public bool Success { get; init; }
    public string? Error { get; init; }
}

public sealed class AuthStatusResponse
{
    public bool AuthenticationEnabled { get; init; }
    public bool PasswordSet { get; init; }
}

public sealed class StateUpdate
{
    public SessionListDto? Sessions { get; init; }
    public UpdateInfo? Update { get; init; }
}

public sealed class SystemHealth
{
    public bool Healthy { get; init; }
    public string Mode { get; init; } = "";
    public int SessionCount { get; init; }
    public string Version { get; init; } = "";
    public int WebProcessId { get; init; }
    public long UptimeSeconds { get; init; }
    public string Platform { get; init; } = "";
    public string? TtyHostVersion { get; init; }
    public string? TtyHostExpected { get; init; }
    public bool? TtyHostCompatible { get; init; }
    public int? WindowsBuildNumber { get; init; }
}
