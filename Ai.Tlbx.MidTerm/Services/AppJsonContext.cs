using System.Text.Json.Serialization;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Mvc;

namespace Ai.Tlbx.MidTerm.Services;

[JsonSerializable(typeof(LogSeverity))]
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
[JsonSerializable(typeof(LocalUpdateInfo))]
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
[JsonSerializable(typeof(LogSubscribeMessage))]
[JsonSerializable(typeof(LogEntryMessage))]
[JsonSerializable(typeof(LogHistoryMessage))]
[JsonSerializable(typeof(LogSessionsMessage))]
[JsonSerializable(typeof(LogSessionInfo))]
[JsonSerializable(typeof(List<LogSessionInfo>))]
[JsonSerializable(typeof(List<LogEntryMessage>))]
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

// Log streaming message types
public sealed class LogSubscribeMessage
{
    public string Action { get; init; } = "";    // "subscribe" | "unsubscribe" | "history"
    public string Type { get; init; } = "";      // "mt" | "mthost"
    public string? SessionId { get; init; }      // For mthost logs
    public int? Limit { get; init; }             // For history requests
}

public sealed class LogEntryMessage
{
    public string MessageType { get; init; } = "log";
    public string Source { get; init; } = "";    // "mt" | "mthost"
    public string? SessionId { get; init; }
    public string Timestamp { get; init; } = "";
    public string Level { get; init; } = "";
    public string Message { get; init; } = "";
}

public sealed class LogHistoryMessage
{
    public string MessageType { get; init; } = "history";
    public string Source { get; init; } = "";
    public string? SessionId { get; init; }
    public List<LogEntryMessage> Entries { get; init; } = [];
    public bool HasMore { get; init; }
}

public sealed class LogSessionsMessage
{
    public string MessageType { get; init; } = "sessions";
    public List<LogSessionInfo> Sessions { get; init; } = [];
}

public sealed class LogSessionInfo
{
    public string Id { get; init; } = "";
    public bool Active { get; init; }
    public int LogCount { get; init; }
}
