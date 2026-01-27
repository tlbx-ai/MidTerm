using System.Text.Json.Serialization;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Mvc;

namespace Ai.Tlbx.MidTerm.Services;

[JsonSerializable(typeof(BootstrapResponse))]
[JsonSerializable(typeof(BootstrapLoginResponse))]
[JsonSerializable(typeof(FeatureFlags))]
[JsonSerializable(typeof(WsCommand))]
[JsonSerializable(typeof(WsCommandPayload))]
[JsonSerializable(typeof(WsCommandResponse))]
[JsonSerializable(typeof(WsSessionCreatedData))]
[JsonSerializable(typeof(SystemResponse))]
[JsonSerializable(typeof(TtyHostInfo))]
[JsonSerializable(typeof(HistoryPatchRequest))]
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
[JsonSerializable(typeof(MidTermSettingsPublic))]
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
[JsonSerializable(typeof(CertificateInfoResponse))]
[JsonSerializable(typeof(CertificateDownloadInfo))]
[JsonSerializable(typeof(SecurityStatus))]
[JsonSerializable(typeof(SharePacketInfo))]
[JsonSerializable(typeof(NetworkEndpointInfo))]
[JsonSerializable(typeof(NetworkEndpointInfo[]))]
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
[JsonSerializable(typeof(LogFilesResponse))]
[JsonSerializable(typeof(LogFileInfo))]
[JsonSerializable(typeof(List<LogFileInfo>))]
[JsonSerializable(typeof(LogReadResponse))]
[JsonSerializable(typeof(SettingsWsMessage))]
[JsonSerializable(typeof(LaunchEntry))]
[JsonSerializable(typeof(List<LaunchEntry>))]
[JsonSerializable(typeof(CreateHistoryRequest))]
[JsonSerializable(typeof(FileCheckRequest))]
[JsonSerializable(typeof(FileCheckResponse))]
[JsonSerializable(typeof(FileRegisterRequest))]
[JsonSerializable(typeof(FileResolveResponse))]
[JsonSerializable(typeof(FilePathInfo))]
[JsonSerializable(typeof(DirectoryListResponse))]
[JsonSerializable(typeof(DirectoryEntry))]
[JsonSerializable(typeof(Dictionary<string, FilePathInfo>))]
[JsonSerializable(typeof(PathsResponse))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, UseStringEnumConverter = true)]
public partial class AppJsonContext : JsonSerializerContext
{
}

/// <summary>
/// Wrapper message for settings WebSocket that can carry settings or update info.
/// </summary>
public sealed class SettingsWsMessage
{
    /// <summary>
    /// Message type: "settings" or "update"
    /// </summary>
    public string Type { get; init; } = "";

    /// <summary>
    /// Settings payload (when Type = "settings")
    /// </summary>
    public MidTermSettings? Settings { get; init; }

    /// <summary>
    /// Update info payload (when Type = "update")
    /// </summary>
    public UpdateInfo? Update { get; init; }
}

/// <summary>
/// Message for subscribing to log streams.
/// </summary>
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
