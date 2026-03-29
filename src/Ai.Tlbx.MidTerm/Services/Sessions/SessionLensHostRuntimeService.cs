using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Ipc;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Services.Hosting;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public sealed class SessionLensHostRuntimeService : IAsyncDisposable
{
    internal delegate bool RedirectedProcessLauncher(
        string fileName,
        IReadOnlyList<string> args,
        string workingDirectory,
        IReadOnlyDictionary<string, string?>? environmentOverrides,
        IReadOnlyList<string>? pathPrependEntries,
        string? runAsUser,
        string? runAsUserSid,
        out TtyHostSpawner.RedirectedProcessHandle? launchedProcess,
        out string? failure);

    private const string CodexMode = "codex";
    private const string OffMode = "off";
    private const string SyntheticMode = "synthetic";
    private const string HostModeEnvironmentVariable = "MIDTERM_LENS_HOST_MODE";
    private static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(10);
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);
    private readonly ConcurrentDictionary<string, HostRuntimeState> _states = new(StringComparer.Ordinal);
    private readonly SessionLensHostIngressService _ingress;
    private readonly SessionLensPulseService _pulse;
    private readonly SettingsService _settingsService;
    private readonly MidTermInstanceIdentity _instanceIdentity;
    private readonly LensHostOwnershipRegistry _ownershipRegistry;
    private readonly bool _preserveHostsOnDispose;
    private readonly string _mode;
    private readonly RedirectedProcessLauncher _launcher;

    public SessionLensHostRuntimeService(
        SessionLensHostIngressService ingress,
        SessionLensPulseService pulse,
        SettingsService settingsService,
        MidTermInstanceIdentity? instanceIdentity = null,
        string? mode = null)
        : this(ingress, pulse, settingsService, instanceIdentity, mode, null)
    {
    }

    internal SessionLensHostRuntimeService(
        SessionLensHostIngressService ingress,
        SessionLensPulseService pulse,
        SettingsService settingsService,
        MidTermInstanceIdentity? instanceIdentity,
        string? mode,
        RedirectedProcessLauncher? launcher)
    {
        _ingress = ingress;
        _pulse = pulse;
        _settingsService = settingsService;
        _instanceIdentity = instanceIdentity ?? MidTermInstanceIdentity.Load(
            Path.Combine(Path.GetTempPath(), "midterm-test-agenthost", Guid.NewGuid().ToString("N")),
            0);
        _ownershipRegistry = new LensHostOwnershipRegistry(
            Path.Combine(
                Path.GetDirectoryName(_instanceIdentity.SessionRegistryPath) ?? Path.GetTempPath(),
                $"lens-host-sessions-{_instanceIdentity.InstanceId}.json"));
        _preserveHostsOnDispose = !IsTestBinaryBaseDirectory(AppContext.BaseDirectory);
        _mode = NormalizeMode(mode ?? Environment.GetEnvironmentVariable(HostModeEnvironmentVariable));
        _launcher = launcher ?? TtyHostSpawner.TryStartRedirectedProcess;
    }

    public bool IsEnabledFor(string? profile)
    {
        return (_mode, profile) switch
        {
            (SyntheticMode, AiCliProfileService.CodexProfile or AiCliProfileService.ClaudeProfile) => true,
            (CodexMode, AiCliProfileService.CodexProfile or AiCliProfileService.ClaudeProfile) => true,
            _ => false
        };
    }

    public bool OwnsSession(string sessionId)
    {
        return _states.TryGetValue(sessionId, out var state) &&
               state.Input is not null &&
               state.Output is not null &&
               state.Status is not HostRuntimeStatus.None and not HostRuntimeStatus.Stopped;
    }

    public async Task<bool> EnsureAttachedAsync(
        string sessionId,
        string profile,
        SessionInfoDto session,
        string? resumeThreadIdOverride = null,
        CancellationToken ct = default)
    {
        return await EnsureAttachedAsync(
            sessionId,
            profile,
            session,
            resumeThreadIdOverride,
            allowSpawn: true,
            ct).ConfigureAwait(false);
    }

    public bool MayHaveRecoverableHost(string sessionId)
    {
        if (OwnsSession(sessionId))
        {
            return true;
        }

        if (_ownershipRegistry.GetSessions().Any(record => string.Equals(record.SessionId, sessionId, StringComparison.Ordinal)))
        {
            return true;
        }

        return LensHostEndpointDiscovery.FindEndpointPid(_instanceIdentity.InstanceId, sessionId).HasValue;
    }

    public async Task<bool> RecoverExistingHostAsync(
        string sessionId,
        string profile,
        SessionInfoDto session,
        string? resumeThreadIdOverride = null,
        CancellationToken ct = default)
    {
        return await EnsureAttachedAsync(
            sessionId,
            profile,
            session,
            resumeThreadIdOverride,
            allowSpawn: false,
            ct).ConfigureAwait(false);
    }

    private async Task<bool> EnsureAttachedAsync(
        string sessionId,
        string profile,
        SessionInfoDto session,
        string? resumeThreadIdOverride,
        bool allowSpawn,
        CancellationToken ct)
    {
        var workingDirectory = session.CurrentDirectory;
        if (!IsEnabledFor(profile) ||
            string.IsNullOrWhiteSpace(sessionId) ||
            string.IsNullOrWhiteSpace(workingDirectory) ||
            !Directory.Exists(workingDirectory))
        {
            return false;
        }

        var state = _states.GetOrAdd(sessionId, static id => new HostRuntimeState(id));
        await state.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            state.Profile = profile;
            state.WorkingDirectory = workingDirectory;
            EnsurePulseSessionSeeded(sessionId, profile);
            var attachPoint = SelectAttachPoint(profile, session);

            if (state.Input is not null && state.Output is not null)
            {
                return true;
            }

            await DisposeStateAsync(state, terminateHost: false).ConfigureAwait(false);
            var settings = _settingsService.Load();
            var userProfileDirectory = ResolveConfiguredUserProfileDirectory(settings);
            var executablePath = attachPoint is null
                ? AiCliCommandLocator.ResolveExecutablePath(profile, session, userProfileDirectory)
                : null;
            var preferredProfileDirectory = ResolvePreferredProfileDirectory(settings, executablePath);
            BuildLaunchEnvironment(
                settings,
                executablePath,
                preferredProfileDirectory,
                _instanceIdentity,
                out var environmentOverrides,
                out var pathPrependEntries);

            if (!await TryConnectExistingHostAsync(state, profile, workingDirectory, ct).ConfigureAwait(false))
            {
                if (!allowSpawn)
                {
                    state.Status = HostRuntimeStatus.None;
                    state.LastError = null;
                    return false;
                }

                if (!TryResolveLaunch(profile, _mode, out var launch))
                {
                    state.Status = HostRuntimeStatus.Error;
                    state.LastError = "mtagenthost executable could not be resolved.";
                    return false;
                }

                if (!_launcher(
                        launch.FileName,
                        BuildIpcLaunchArguments(launch.Arguments, sessionId, _instanceIdentity.InstanceId, _instanceIdentity.OwnerToken),
                        workingDirectory,
                        environmentOverrides,
                        pathPrependEntries,
                        settings.RunAsUser,
                        settings.RunAsUserSid,
                        out var launchedProcess,
                        out var launchFailure))
                {
                    state.Status = HostRuntimeStatus.Error;
                    state.LastError = string.IsNullOrWhiteSpace(launchFailure)
                        ? "mtagenthost process failed to start."
                        : launchFailure;
                    return false;
                }

                if (launchedProcess is null)
                {
                    state.Status = HostRuntimeStatus.Error;
                    state.LastError = "mtagenthost process launcher returned no handle.";
                    return false;
                }

                try { launchedProcess.Input.Dispose(); } catch { }
                try { launchedProcess.Output.Dispose(); } catch { }

                state.Process = launchedProcess.Process;
                state.Error = launchedProcess.Error;

                if (!await ConnectToSpawnedHostAsync(state, ct).ConfigureAwait(false))
                {
                    state.LastError = "mtagenthost IPC endpoint did not become available.";
                    await DisposeStateAsync(state, terminateHost: true).ConfigureAwait(false);
                    state.Status = HostRuntimeStatus.Error;
                    return false;
                }
            }

            var attachResult = await SendCommandAsync(
                state,
                commandId => new LensHostCommandEnvelope
                {
                    CommandId = commandId,
                    SessionId = sessionId,
                    Type = "runtime.attach",
                    AttachRuntime = new LensAttachRuntimeRequest
                    {
                        SessionId = sessionId,
                        Provider = profile,
                        WorkingDirectory = workingDirectory,
                        InstanceId = _instanceIdentity.InstanceId,
                        OwnerToken = _instanceIdentity.OwnerToken,
                        AttachPoint = attachPoint,
                        ExecutablePath = executablePath,
                        UserProfileDirectory = preferredProfileDirectory,
                        ResumeThreadId = resumeThreadIdOverride ?? attachPoint?.PreferredThreadId
                    }
                },
                ct).ConfigureAwait(false);

            state.Status = attachResult.Status == "accepted" ? HostRuntimeStatus.Ready : HostRuntimeStatus.Error;
            state.LastError = attachResult.Status == "accepted" ? null : attachResult.Message;
            if (attachResult.Status == "accepted")
            {
                state.TransportKey = attachPoint?.TransportKind ?? "mtagenthost-ipc";
                state.TransportLabel = DescribeTransportLabel(_mode, profile, attachPoint);
                _ownershipRegistry.Upsert(sessionId, state.HostPid, profile, workingDirectory);
                await SyncPulseFromHostAsync(state, ct).ConfigureAwait(false);
                EnsurePulseSessionSeeded(sessionId, profile);
                await WaitForPulseSnapshotAsync(sessionId, ct).ConfigureAwait(false);
            }
            return attachResult.Status == "accepted";
        }
        finally
        {
            state.Gate.Release();
        }
    }

    private static SessionAgentAttachPoint? SelectAttachPoint(string profile, SessionInfoDto session)
    {
        if (session.AgentAttachPoint is null)
        {
            return null;
        }

        return string.Equals(session.AgentAttachPoint.Provider, profile, StringComparison.OrdinalIgnoreCase)
            ? session.AgentAttachPoint
            : null;
    }

    public async Task<bool> TrySendPromptAsync(
        string sessionId,
        SessionPromptRequest request,
        CancellationToken ct = default)
    {
        if (!_states.TryGetValue(sessionId, out var state))
        {
            return false;
        }

        if (!SessionApiEndpoints.TryGetInputBytes(
                new SessionInputRequest
                {
                    Text = request.Text,
                    Base64 = request.Base64,
                    AppendNewline = false
                },
                out var promptBytes,
                out _))
        {
            return false;
        }

        var promptText = Encoding.UTF8.GetString(promptBytes);
        if (string.IsNullOrWhiteSpace(promptText))
        {
            return false;
        }

        await StartTurnAsync(
            sessionId,
            new LensTurnRequest
            {
                Text = promptText,
                Attachments = []
            },
            ct).ConfigureAwait(false);
        return true;
    }

    public async Task<LensTurnStartResponse> StartTurnAsync(
        string sessionId,
        LensTurnRequest request,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        var state = GetRequiredState(sessionId);

        await state.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var result = await SendCommandAsync(
                state,
                commandId => new LensHostCommandEnvelope
                {
                    CommandId = commandId,
                    SessionId = sessionId,
                    Type = "turn.start",
                    StartTurn = request
                },
                ct).ConfigureAwait(false);

            state.Status = HostRuntimeStatus.Running;
            var turnStarted = result.TurnStarted
                              ?? throw new InvalidOperationException("Lens host did not return turn-start metadata.");
            return turnStarted;
        }
        finally
        {
            state.Gate.Release();
        }
    }

    public async Task<LensCommandAcceptedResponse> InterruptTurnAsync(
        string sessionId,
        LensInterruptRequest request,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        var state = GetRequiredState(sessionId);

        await state.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var result = await SendCommandAsync(
                state,
                commandId => new LensHostCommandEnvelope
                {
                    CommandId = commandId,
                    SessionId = sessionId,
                    Type = "turn.interrupt",
                    InterruptTurn = request
                },
                ct).ConfigureAwait(false);

            return result.Accepted ?? new LensCommandAcceptedResponse
            {
                SessionId = sessionId,
                Status = result.Status
            };
        }
        finally
        {
            state.Gate.Release();
        }
    }

    public async Task<LensCommandAcceptedResponse> ResolveRequestAsync(
        string sessionId,
        string requestId,
        LensRequestDecisionRequest request,
        CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(requestId);
        ArgumentNullException.ThrowIfNull(request);
        var state = GetRequiredState(sessionId);

        await state.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var result = await SendCommandAsync(
                state,
                commandId => new LensHostCommandEnvelope
                {
                    CommandId = commandId,
                    SessionId = sessionId,
                    Type = "request.resolve",
                    ResolveRequest = new LensRequestResolutionCommand
                    {
                        RequestId = requestId,
                        Decision = request.Decision
                    }
                },
                ct).ConfigureAwait(false);

            return result.Accepted ?? new LensCommandAcceptedResponse
            {
                SessionId = sessionId,
                Status = result.Status,
                RequestId = requestId
            };
        }
        finally
        {
            state.Gate.Release();
        }
    }

    public async Task<LensCommandAcceptedResponse> ResolveUserInputAsync(
        string sessionId,
        string requestId,
        LensUserInputAnswerRequest request,
        CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(requestId);
        ArgumentNullException.ThrowIfNull(request);
        var state = GetRequiredState(sessionId);

        await state.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var result = await SendCommandAsync(
                state,
                commandId => new LensHostCommandEnvelope
                {
                    CommandId = commandId,
                    SessionId = sessionId,
                    Type = "user-input.resolve",
                    ResolveUserInput = new LensUserInputResolutionCommand
                    {
                        RequestId = requestId,
                        Answers = request.Answers
                    }
                },
                ct).ConfigureAwait(false);

            return result.Accepted ?? new LensCommandAcceptedResponse
            {
                SessionId = sessionId,
                Status = result.Status,
                RequestId = requestId
            };
        }
        finally
        {
            state.Gate.Release();
        }
    }

    public bool TryGetSnapshot(string sessionId, out LensRuntimeSnapshot snapshot)
    {
        snapshot = default!;
        if (!_states.TryGetValue(sessionId, out var state) ||
            state.Status == HostRuntimeStatus.None ||
            state.Status == HostRuntimeStatus.Stopped ||
            state.Input is null ||
            state.Output is null)
        {
            return false;
        }

        var pulseSnapshot = _pulse.GetSnapshot(sessionId);
        snapshot = new LensRuntimeSnapshot
        {
            SessionId = sessionId,
            Profile = state.Profile ?? AiCliProfileService.UnknownProfile,
            TransportKey = state.TransportKey,
            TransportLabel = state.TransportLabel,
            Status = ToStatusValue(state.Status),
            StatusLabel = ToStatusLabel(state.Status),
            LastError = state.LastError ?? pulseSnapshot?.Session.LastError,
            LastEventAt = pulseSnapshot?.Session.LastEventAt,
            AssistantText = pulseSnapshot?.Streams.AssistantText,
            UnifiedDiff = pulseSnapshot?.Streams.UnifiedDiff,
            PendingQuestion = pulseSnapshot?.Requests.FirstOrDefault(static request => request.Kind == "tool_user_input" && request.State == "open")?.Detail,
            Activities = []
        };
        return true;
    }

    public void Forget(string sessionId)
    {
        if (_states.TryRemove(sessionId, out var state))
        {
            _ = DisposeStateAsync(state, terminateHost: true);
        }

        _ownershipRegistry.Remove(sessionId);
    }

    public async Task DetachAsync(string sessionId, CancellationToken ct = default)
    {
        if (!_states.TryRemove(sessionId, out var state))
        {
            return;
        }

        await state.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await DisposeStateAsync(state, terminateHost: true).ConfigureAwait(false);
        }
        finally
        {
            state.Gate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var state in _states.Values)
        {
            await DisposeStateAsync(state, terminateHost: !_preserveHostsOnDispose).ConfigureAwait(false);
        }

        _states.Clear();
    }

    private async Task ReadLoopAsync(HostRuntimeState state)
    {
        try
        {
            while (state.Output is not null)
            {
                var line = await state.Output.ReadLineAsync().ConfigureAwait(false);
                if (line is null)
                {
                    break;
                }

                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                using var json = JsonDocument.Parse(line);
                var root = json.RootElement;
                if (root.TryGetProperty("event", out _))
                {
                    var envelope = JsonSerializer.Deserialize(line, LensHostJsonContext.Default.LensHostEventEnvelope);
                    if (envelope is null)
                    {
                        continue;
                    }

                    UpdateStateFromEvent(state, envelope.Event);
                    _ingress.ApplyEvent(envelope);
                    continue;
                }

                if (root.TryGetProperty("commandId", out var commandIdProperty))
                {
                    var commandId = commandIdProperty.GetString();
                    var result = JsonSerializer.Deserialize(line, LensHostJsonContext.Default.LensHostCommandResultEnvelope);
                    if (result is null || string.IsNullOrWhiteSpace(commandId))
                    {
                        continue;
                    }

                    if (state.PendingCommands.TryRemove(commandId, out var pending))
                    {
                        pending.TrySetResult(result);
                    }
                }
            }
        }
        catch (Exception ex)
        {
            state.LastError = ex.Message;
            state.Status = HostRuntimeStatus.Error;
            Log.Warn(() => $"SessionLensHostRuntimeService read loop failed for {state.SessionId}: {ex.Message}");
        }
    }

    private async Task ReadErrorLoopAsync(HostRuntimeState state)
    {
        try
        {
            while (state.Error is not null)
            {
                var line = await state.Error.ReadLineAsync().ConfigureAwait(false);
                if (line is null)
                {
                    break;
                }

                if (!string.IsNullOrWhiteSpace(line))
                {
                    state.LastError = line.Trim();
                    Log.Info(() => $"mtagenthost[{state.SessionId}] {line.Trim()}");
                }
            }
        }
        catch (Exception ex)
        {
            state.LastError = ex.Message;
            Log.Warn(() => $"SessionLensHostRuntimeService stderr loop failed for {state.SessionId}: {ex.Message}");
        }
    }

    private async Task<LensHostCommandResultEnvelope> SendCommandAsync(
        HostRuntimeState state,
        Func<string, LensHostCommandEnvelope> createCommand,
        CancellationToken ct)
    {
        var commandId = Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture);
        var pending = new TaskCompletionSource<LensHostCommandResultEnvelope>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!state.PendingCommands.TryAdd(commandId, pending))
        {
            throw new InvalidOperationException("Failed to track Lens host command.");
        }

        try
        {
            var command = createCommand(commandId);
            var payload = JsonSerializer.Serialize(command, LensHostJsonContext.Default.LensHostCommandEnvelope);
            await state.Input!.WriteLineAsync(payload).ConfigureAwait(false);
            await state.Input.FlushAsync().ConfigureAwait(false);

            var result = await pending.Task.WaitAsync(CommandTimeout, ct).ConfigureAwait(false);
            if (!string.Equals(result.Status, "accepted", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(result.Message ?? $"Lens host rejected command '{command.Type}'.");
            }

            return result;
        }
        finally
        {
            state.PendingCommands.TryRemove(commandId, out _);
        }
    }

    private static async Task<string> ReadLineWithTimeoutAsync(StreamReader reader, CancellationToken ct)
    {
        var line = await reader.ReadLineAsync(ct).AsTask().WaitAsync(CommandTimeout, ct).ConfigureAwait(false);
        return line ?? throw new EndOfStreamException("mtagenthost closed stdout before sending hello.");
    }

    private async Task<bool> TryConnectExistingHostAsync(
        HostRuntimeState state,
        string profile,
        string workingDirectory,
        CancellationToken ct)
    {
        var recorded = _ownershipRegistry.GetSessions()
            .FirstOrDefault(record => string.Equals(record.SessionId, state.SessionId, StringComparison.Ordinal));
        if (recorded is not null)
        {
            if (await TryConnectToHostAsync(state, recorded.HostPid, ct).ConfigureAwait(false))
            {
                state.Profile = string.IsNullOrWhiteSpace(recorded.Profile) ? profile : recorded.Profile;
                state.WorkingDirectory = string.IsNullOrWhiteSpace(recorded.WorkingDirectory) ? workingDirectory : recorded.WorkingDirectory;
                return true;
            }

            _ownershipRegistry.Remove(state.SessionId);
            LensHostEndpointDiscovery.CleanupEndpoint(_instanceIdentity.InstanceId, state.SessionId, recorded.HostPid);
        }

        var discoveredPid = LensHostEndpointDiscovery.FindEndpointPid(_instanceIdentity.InstanceId, state.SessionId);
        if (discoveredPid is int hostPid && await TryConnectToHostAsync(state, hostPid, ct).ConfigureAwait(false))
        {
            state.Profile = profile;
            state.WorkingDirectory = workingDirectory;
            return true;
        }

        return false;
    }

    private async Task<bool> ConnectToSpawnedHostAsync(HostRuntimeState state, CancellationToken ct)
    {
        if (state.Process is null)
        {
            return false;
        }

        await Task.Delay(50, ct).ConfigureAwait(false);
        var launchedPid = state.Process.Id;
        for (var wait = 50; wait <= 800; wait *= 2)
        {
            if (state.Process.HasExited)
            {
                return false;
            }

            if (await TryConnectToHostAsync(state, launchedPid, ct, connectTimeoutMs: 125).ConfigureAwait(false))
            {
                return true;
            }

            var discoveredPid = LensHostEndpointDiscovery.FindEndpointPid(_instanceIdentity.InstanceId, state.SessionId);
            if (discoveredPid is int hostPid &&
                hostPid != launchedPid &&
                await TryConnectToHostAsync(state, hostPid, ct, connectTimeoutMs: 125).ConfigureAwait(false))
            {
                return true;
            }

            await Task.Delay(wait, ct).ConfigureAwait(false);
        }

        return false;
    }

    private async Task<bool> TryConnectToHostAsync(
        HostRuntimeState state,
        int hostPid,
        CancellationToken ct,
        int connectTimeoutMs = 1000)
    {
        await DisposeStreamsAsync(state).ConfigureAwait(false);

        var endpoint = LensHostEndpoint.GetSessionEndpoint(_instanceIdentity.InstanceId, state.SessionId, hostPid);
        HostTransportConnection? connection = null;
        try
        {
            connection = await HostTransportConnection.ConnectAsync(endpoint, connectTimeoutMs, ct).ConfigureAwait(false);
            var helloLine = await ReadLineWithTimeoutAsync(connection.Reader, ct).ConfigureAwait(false);
            var hello = JsonSerializer.Deserialize(helloLine, LensHostJsonContext.Default.LensHostHello)
                        ?? throw new InvalidOperationException("Lens host hello payload was empty.");
            _ingress.ValidateHello(hello);

            state.Connection = connection;
            state.Input = connection.Writer;
            state.Output = connection.Reader;
            state.HostPid = hostPid;
            state.TransportKey = "mtagenthost-ipc";
            state.TransportLabel = "mtagenthost owned IPC";
            state.Status = HostRuntimeStatus.Starting;
            state.ReaderTask = Task.Run(() => ReadLoopAsync(state), CancellationToken.None);
            if (state.Error is not null)
            {
                state.ErrorTask = Task.Run(() => ReadErrorLoopAsync(state), CancellationToken.None);
            }

            return true;
        }
        catch
        {
            connection?.Dispose();
            return false;
        }
    }

    private async Task SyncPulseFromHostAsync(HostRuntimeState state, CancellationToken ct)
    {
        var fullHistory = await GetHostEventsAsync(state, 0, ct).ConfigureAwait(false);
        _pulse.Forget(state.SessionId);
        foreach (var lensEvent in fullHistory.Events)
        {
            _pulse.Append(lensEvent);
        }
    }

    private async Task WaitForPulseSnapshotAsync(string sessionId, CancellationToken ct)
    {
        if (_pulse.GetSnapshot(sessionId) is not null)
        {
            return;
        }

        var deadline = DateTime.UtcNow + TimeSpan.FromMilliseconds(250);
        while (DateTime.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            await Task.Delay(15, ct).ConfigureAwait(false);
            if (_pulse.GetSnapshot(sessionId) is not null)
            {
                return;
            }
        }
    }

    private async Task<LensPulseEventListResponse> GetHostEventsAsync(
        HostRuntimeState state,
        long afterSequence,
        CancellationToken ct)
    {
        var result = await SendCommandAsync(
            state,
            commandId => new LensHostCommandEnvelope
            {
                CommandId = commandId,
                SessionId = state.SessionId,
                Type = "events.get",
                EventsRequest = new LensHostEventsRequest
                {
                    AfterSequence = afterSequence
                }
            },
            ct).ConfigureAwait(false);

        return result.Events ?? new LensPulseEventListResponse
        {
            SessionId = state.SessionId
        };
    }

    private static void UpdateStateFromEvent(HostRuntimeState state, LensPulseEvent lensEvent)
    {
        state.LastError = lensEvent.RuntimeMessage?.Message is not null && lensEvent.Type == "runtime.error"
            ? lensEvent.RuntimeMessage.Message
            : state.LastError;

        state.Status = lensEvent.Type switch
        {
            "session.started" => HostRuntimeStatus.Starting,
            "session.ready" => HostRuntimeStatus.Ready,
            "turn.started" => HostRuntimeStatus.Running,
            "turn.completed" or "turn.aborted" => HostRuntimeStatus.Ready,
            "runtime.error" => HostRuntimeStatus.Error,
            _ => state.Status
        };
    }

    private static string NormalizeMode(string? mode)
    {
        return (mode ?? CodexMode).Trim().ToLowerInvariant() switch
        {
            SyntheticMode => SyntheticMode,
            CodexMode => CodexMode,
            _ => OffMode
        };
    }

    private void EnsurePulseSessionSeeded(string sessionId, string profile)
    {
        if (_pulse.GetSnapshot(sessionId) is not null)
        {
            return;
        }

        _pulse.Append(new LensPulseEvent
        {
            EventId = $"seed-{Guid.NewGuid():N}",
            SessionId = sessionId,
            Provider = profile,
            CreatedAt = DateTimeOffset.UtcNow,
            Type = "session.started",
            SessionState = new LensPulseSessionStatePayload
            {
                State = "starting",
                StateLabel = "Starting",
                Reason = "Lens runtime attached and waiting for provider events."
            }
        });
    }

    private static string ToStatusValue(HostRuntimeStatus status)
    {
        return status switch
        {
            HostRuntimeStatus.Starting => "starting",
            HostRuntimeStatus.Running => "running",
            HostRuntimeStatus.Error => "error",
            HostRuntimeStatus.Stopped => "stopped",
            HostRuntimeStatus.Ready => "ready",
            _ => "ready"
        };
    }

    private static string ToStatusLabel(HostRuntimeStatus status)
    {
        return status switch
        {
            HostRuntimeStatus.Starting => "Starting",
            HostRuntimeStatus.Running => "Running",
            HostRuntimeStatus.Error => "Error",
            HostRuntimeStatus.Stopped => "Stopped",
            HostRuntimeStatus.Ready => "Ready",
            _ => "Ready"
        };
    }

    private static string DescribeTransportLabel(string mode, string profile, SessionAgentAttachPoint? attachPoint)
    {
        if (attachPoint is null && string.Equals(mode, CodexMode, StringComparison.Ordinal))
        {
            return "mtagenthost owned IPC";
        }

        if (attachPoint is not null)
        {
            return attachPoint.TransportKind switch
            {
                SessionAgentAttachPoint.CodexAppServerWebSocketTransport => "Codex app-server websocket",
                _ => attachPoint.TransportKind
            };
        }

        return mode switch
        {
            SyntheticMode => "mtagenthost synthetic stdio",
            CodexMode => $"mtagenthost {profile} stdio",
            _ => "mtagenthost stdio"
        };
    }

    private static void BuildLaunchEnvironment(
        MidTermSettings settings,
        string? executablePath,
        string? profileDirectory,
        MidTermInstanceIdentity instanceIdentity,
        out Dictionary<string, string?> environmentOverrides,
        out List<string> pathPrependEntries)
    {
        environmentOverrides = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        pathPrependEntries = [];

        static void AddPathEntry(List<string> entries, string? directory)
        {
            if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory))
            {
                return;
            }

            if (!entries.Exists(existing => string.Equals(existing, directory, StringComparison.OrdinalIgnoreCase)))
            {
                entries.Add(directory);
            }
        }

        var executableDirectory = Path.GetDirectoryName(executablePath);
        if (!string.IsNullOrWhiteSpace(executableDirectory))
        {
            AddPathEntry(pathPrependEntries, executableDirectory);
        }

        if (OperatingSystem.IsWindows())
        {
            foreach (var directory in AiCliCommandLocator.GetWellKnownWindowsCommandDirectories(
                         Environment.GetEnvironmentVariable("APPDATA"),
                         Environment.GetEnvironmentVariable("LOCALAPPDATA"),
                         Environment.GetEnvironmentVariable("USERPROFILE")))
            {
                AddPathEntry(pathPrependEntries, directory);
            }
        }

        if (!string.IsNullOrWhiteSpace(profileDirectory))
        {
            if (Directory.Exists(profileDirectory))
            {
                environmentOverrides["USERPROFILE"] = profileDirectory;
                environmentOverrides["HOME"] = profileDirectory;
                environmentOverrides["CODEX_HOME"] = Path.Combine(profileDirectory, ".codex");

                var root = Path.GetPathRoot(profileDirectory);
                if (!string.IsNullOrWhiteSpace(root))
                {
                    environmentOverrides["HOMEDRIVE"] = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                    environmentOverrides["HOMEPATH"] = profileDirectory[root.Length..];
                }

                var appDataDirectory = Path.Combine(profileDirectory, "AppData", "Roaming");
                var localAppDataDirectory = Path.Combine(profileDirectory, "AppData", "Local");
                environmentOverrides["APPDATA"] = appDataDirectory;
                environmentOverrides["LOCALAPPDATA"] = localAppDataDirectory;
                foreach (var directory in AiCliCommandLocator.GetUserCommandDirectories(profileDirectory).Reverse())
                {
                    AddPathEntry(pathPrependEntries, directory);
                }
            }
        }

        ApplyProviderSettings(environmentOverrides, settings);
        environmentOverrides["MIDTERM_INSTANCE_ID"] = instanceIdentity.InstanceId;
        environmentOverrides["MIDTERM_OWNER_TOKEN"] = instanceIdentity.OwnerToken;
    }

    private static string? ResolveConfiguredUserProfileDirectory(MidTermSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        if (!OperatingSystem.IsWindows() || string.IsNullOrWhiteSpace(settings.RunAsUser))
        {
            return null;
        }

        return LensHostEnvironmentResolver.ResolveWindowsProfileDirectory(settings.RunAsUser, settings.RunAsUserSid);
    }

    private static string? ResolvePreferredProfileDirectory(MidTermSettings settings, string? executablePath)
    {
        ArgumentNullException.ThrowIfNull(settings);
        if (!OperatingSystem.IsWindows())
        {
            return null;
        }

        return ResolveConfiguredUserProfileDirectory(settings)
               ?? LensHostEnvironmentResolver.ResolveWindowsProfileDirectoryFromExecutablePath(executablePath)
               ?? LensHostEnvironmentResolver.ResolveCurrentWindowsProfileDirectory();
    }

    private static void ApplyProviderSettings(IDictionary<string, string?> environment, MidTermSettings settings)
    {
        environment["MIDTERM_LENS_CODEX_YOLO_DEFAULT"] = settings.CodexYoloDefault ? "true" : "false";
        environment["MIDTERM_LENS_CODEX_ENVIRONMENT_VARIABLES"] = settings.CodexEnvironmentVariables ?? string.Empty;
        environment["MIDTERM_LENS_CLAUDE_ENVIRONMENT_VARIABLES"] = settings.ClaudeEnvironmentVariables ?? string.Empty;
        environment["MIDTERM_LENS_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS"] =
            settings.ClaudeDangerouslySkipPermissionsDefault ? "true" : "false";
    }

    private static bool TryResolveLaunch(string profile, string mode, out HostLaunch launch)
    {
        var executableName = OperatingSystem.IsWindows() ? "mtagenthost.exe" : "mtagenthost";
        var baseDir = AppContext.BaseDirectory;
        if (IsTestBinaryBaseDirectory(baseDir) && TryResolveDevLaunch(profile, mode, baseDir, out launch))
        {
            return true;
        }

        var installedExecutable = Path.Combine(baseDir, executableName);
        var installedDll = Path.ChangeExtension(installedExecutable, ".dll");
        var installedRuntimeConfig = Path.ChangeExtension(installedExecutable, ".runtimeconfig.json");
        var hasFrameworkPayload = File.Exists(installedDll);
        var looksLikeBrokenAppHost = OperatingSystem.IsWindows() && File.Exists(installedRuntimeConfig) && !hasFrameworkPayload;
        if (File.Exists(installedExecutable) && !looksLikeBrokenAppHost)
        {
            launch = new HostLaunch(
                installedExecutable,
                string.Equals(mode, SyntheticMode, StringComparison.Ordinal)
                    ? ["--stdio", "--synthetic", profile]
                    : ["--stdio"]);
            return true;
        }

        return TryResolveDevLaunch(profile, mode, baseDir, out launch);
    }

    private static bool TryResolveDevLaunch(string profile, string mode, string baseDir, out HostLaunch launch)
    {
        var repoRoot = Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", ".."));
        var devDllCandidates = new[]
        {
            Path.Combine(repoRoot, "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "win-x64", "mtagenthost.dll"),
            Path.Combine(repoRoot, "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "win-x64", "Ai.Tlbx.MidTerm.AgentHost.dll"),
            Path.Combine(repoRoot, "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "mtagenthost.dll"),
            Path.Combine(repoRoot, "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "Ai.Tlbx.MidTerm.AgentHost.dll")
        };
        var devDll = devDllCandidates.FirstOrDefault(File.Exists);
        if (!string.IsNullOrWhiteSpace(devDll))
        {
            var dotnetHost = ResolveDotNetHostPath();
            if (string.IsNullOrWhiteSpace(dotnetHost))
            {
                launch = default;
                return false;
            }

            launch = new HostLaunch(
                dotnetHost,
                string.Equals(mode, SyntheticMode, StringComparison.Ordinal)
                    ? [devDll, "--stdio", "--synthetic", profile]
                    : [devDll, "--stdio"]);
            return true;
        }

        launch = default;
        return false;
    }

    private static bool IsTestBinaryBaseDirectory(string baseDir)
    {
        return baseDir.Contains("Ai.Tlbx.MidTerm.UnitTests", StringComparison.OrdinalIgnoreCase) ||
               baseDir.Contains("Ai.Tlbx.MidTerm.Tests", StringComparison.OrdinalIgnoreCase);
    }

    private static string? ResolveDotNetHostPath()
    {
        var hostPath = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH");
        if (!string.IsNullOrWhiteSpace(hostPath) && File.Exists(hostPath))
        {
            return hostPath;
        }

        var processPath = Environment.ProcessPath;
        if (!string.IsNullOrWhiteSpace(processPath) &&
            string.Equals(Path.GetFileNameWithoutExtension(processPath), "dotnet", StringComparison.OrdinalIgnoreCase))
        {
            return processPath;
        }

        return AiCliCommandLocator.FindExecutableInPath("dotnet");
    }

    private HostRuntimeState GetRequiredState(string sessionId)
    {
        if (!_states.TryGetValue(sessionId, out var state))
        {
            throw new InvalidOperationException($"Lens host runtime is not attached: missing state for {sessionId}.");
        }

        if (state.Input is null)
        {
            throw new InvalidOperationException(
                $"Lens host runtime is not attached: state exists for {sessionId} but input is null (status={state.Status}, hostPid={state.HostPid}, hasConnection={(state.Connection is not null).ToString().ToLowerInvariant()}, hasProcess={(state.Process is not null).ToString().ToLowerInvariant()}).");
        }

        return state;
    }

    private static async Task DisposeStreamsAsync(HostRuntimeState state)
    {
        foreach (var pending in state.PendingCommands.Values)
        {
            pending.TrySetException(new InvalidOperationException("Lens host runtime connection is closing."));
        }

        state.PendingCommands.Clear();
        state.Connection?.Dispose();
        state.Connection = null;
        state.Input = null;
        state.Output = null;

        if (state.ReaderTask is not null)
        {
            await Task.WhenAny(state.ReaderTask, Task.Delay(250)).ConfigureAwait(false);
            state.ReaderTask = null;
        }
    }

    private static async Task DisposeStateAsync(HostRuntimeState state, bool terminateHost)
    {
        foreach (var pending in state.PendingCommands.Values)
        {
            pending.TrySetException(new InvalidOperationException("Lens host runtime is shutting down."));
        }

        state.PendingCommands.Clear();

        try
        {
            if (terminateHost && state.Process is { HasExited: false } process)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync().ConfigureAwait(false);
            }
        }
        catch
        {
        }

        state.Connection?.Dispose();
        state.Connection = null;
        state.Input = null;
        state.Output = null;
        try { state.Error?.Dispose(); } catch { }
        try { state.Process?.Dispose(); } catch { }

        if (state.ReaderTask is not null)
        {
            await Task.WhenAny(state.ReaderTask, Task.Delay(250)).ConfigureAwait(false);
        }

        if (state.ErrorTask is not null)
        {
            await Task.WhenAny(state.ErrorTask, Task.Delay(250)).ConfigureAwait(false);
        }

        state.Status = HostRuntimeStatus.Stopped;
    }

    private sealed class HostRuntimeState
    {
        public HostRuntimeState(string sessionId)
        {
            SessionId = sessionId;
        }

        public string SessionId { get; }
        public SemaphoreSlim Gate { get; } = new(1, 1);
        public ConcurrentDictionary<string, TaskCompletionSource<LensHostCommandResultEnvelope>> PendingCommands { get; } = new(StringComparer.Ordinal);
        public string? Profile { get; set; }
        public string? WorkingDirectory { get; set; }
        public string TransportKey { get; set; } = string.Empty;
        public string TransportLabel { get; set; } = string.Empty;
        public string? LastError { get; set; }
        public HostRuntimeStatus Status { get; set; }
        public int HostPid { get; set; }
        public HostTransportConnection? Connection { get; set; }
        public Process? Process { get; set; }
        public StreamWriter? Input { get; set; }
        public StreamReader? Output { get; set; }
        public StreamReader? Error { get; set; }
        public Task? ReaderTask { get; set; }
        public Task? ErrorTask { get; set; }
    }

    private sealed class HostTransportConnection : IDisposable
    {
        private readonly IDisposable _handle;

        private HostTransportConnection(IDisposable handle, Stream stream)
        {
            _handle = handle;
            Reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true);
            Writer = new StreamWriter(stream, Utf8NoBom, bufferSize: 1024, leaveOpen: true) { AutoFlush = true };
        }

        public StreamReader Reader { get; }
        public StreamWriter Writer { get; }

        public static async Task<HostTransportConnection> ConnectAsync(string endpoint, int timeoutMs, CancellationToken ct)
        {
            if (OperatingSystem.IsWindows())
            {
                var pipe = new NamedPipeClientStream(".", endpoint, PipeDirection.InOut, PipeOptions.Asynchronous);
                await pipe.ConnectAsync(timeoutMs, ct).ConfigureAwait(false);
                return new HostTransportConnection(pipe, pipe);
            }

            var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(timeoutMs);
            await socket.ConnectAsync(new UnixDomainSocketEndPoint(endpoint), timeoutCts.Token).ConfigureAwait(false);
            var stream = new NetworkStream(socket, ownsSocket: true);
            return new HostTransportConnection(stream, stream);
        }

        public void Dispose()
        {
            try { Writer.Dispose(); } catch { }
            try { Reader.Dispose(); } catch { }
            try { _handle.Dispose(); } catch { }
        }
    }

    private static IReadOnlyList<string> BuildIpcLaunchArguments(
        IReadOnlyList<string> args,
        string sessionId,
        string instanceId,
        string ownerToken)
    {
        var updated = new List<string>(args.Count + 7);
        foreach (var arg in args)
        {
            if (string.Equals(arg, "--stdio", StringComparison.Ordinal))
            {
                updated.Add("--ipc");
            }
            else
            {
                updated.Add(arg);
            }
        }

        updated.Add("--session-id");
        updated.Add(sessionId);
        updated.Add("--instance-id");
        updated.Add(instanceId);
        updated.Add("--owner-token");
        updated.Add(ownerToken);
        return updated;
    }

    private readonly record struct HostLaunch(string FileName, IReadOnlyList<string> Arguments);

    private enum HostRuntimeStatus
    {
        None,
        Starting,
        Ready,
        Running,
        Error,
        Stopped
    }
}
