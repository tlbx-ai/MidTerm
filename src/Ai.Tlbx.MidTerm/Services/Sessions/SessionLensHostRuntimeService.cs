using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models.Sessions;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public sealed class SessionLensHostRuntimeService : IAsyncDisposable
{
    private const string CodexMode = "codex";
    private const string OffMode = "off";
    private const string SyntheticMode = "synthetic";
    private const string HostModeEnvironmentVariable = "MIDTERM_LENS_HOST_MODE";
    private static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(10);
    private readonly ConcurrentDictionary<string, HostRuntimeState> _states = new(StringComparer.Ordinal);
    private readonly SessionLensHostIngressService _ingress;
    private readonly SessionLensPulseService _pulse;
    private readonly string _mode;

    public SessionLensHostRuntimeService(
        SessionLensHostIngressService ingress,
        SessionLensPulseService pulse,
        string? mode = null)
    {
        _ingress = ingress;
        _pulse = pulse;
        _mode = NormalizeMode(mode ?? Environment.GetEnvironmentVariable(HostModeEnvironmentVariable));
    }

    public bool IsEnabledFor(string? profile)
    {
        return (_mode, profile) switch
        {
            (SyntheticMode, AiCliProfileService.CodexProfile or AiCliProfileService.ClaudeProfile) => true,
            (CodexMode, AiCliProfileService.CodexProfile) => true,
            _ => false
        };
    }

    public bool OwnsSession(string sessionId)
    {
        return _states.TryGetValue(sessionId, out var state) &&
               state.Status is not HostRuntimeStatus.None and not HostRuntimeStatus.Stopped;
    }

    public async Task<bool> EnsureAttachedAsync(
        string sessionId,
        string profile,
        string workingDirectory,
        CancellationToken ct = default)
    {
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

            if (state.Process is { HasExited: false } && state.Input is not null && state.Output is not null)
            {
                return true;
            }

            await DisposeStateAsync(state).ConfigureAwait(false);
            if (!TryResolveLaunch(profile, _mode, out var launch))
            {
                state.Status = HostRuntimeStatus.Error;
                state.LastError = "mtagenthost executable could not be resolved.";
                return false;
            }

            var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = launch.FileName,
                    Arguments = launch.Arguments,
                    WorkingDirectory = workingDirectory,
                    UseShellExecute = false,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                },
                EnableRaisingEvents = true
            };

            if (!process.Start())
            {
                state.Status = HostRuntimeStatus.Error;
                state.LastError = "mtagenthost process failed to start.";
                return false;
            }

            state.Process = process;
            state.Input = process.StandardInput;
            state.Output = process.StandardOutput;
            state.Error = process.StandardError;
            state.TransportKey = "mtagenthost-stdio";
            state.TransportLabel = _mode switch
            {
                SyntheticMode => "mtagenthost synthetic stdio",
                CodexMode => "mtagenthost codex stdio",
                _ => "mtagenthost stdio"
            };
            state.Status = HostRuntimeStatus.Starting;

            var helloLine = await ReadLineWithTimeoutAsync(process.StandardOutput, ct).ConfigureAwait(false);
            var hello = JsonSerializer.Deserialize(helloLine, LensHostJsonContext.Default.LensHostHello)
                        ?? throw new InvalidOperationException("Lens host hello payload was empty.");
            _ingress.ValidateHello(hello);

            state.ReaderTask = Task.Run(() => ReadLoopAsync(state), CancellationToken.None);
            state.ErrorTask = Task.Run(() => ReadErrorLoopAsync(state), CancellationToken.None);
            process.Exited += (_, _) =>
            {
                state.Status = process.ExitCode == 0 ? HostRuntimeStatus.Stopped : HostRuntimeStatus.Error;
                state.LastError = process.ExitCode == 0
                    ? state.LastError
                    : $"mtagenthost exited with code {process.ExitCode.ToString(CultureInfo.InvariantCulture)}.";
            };

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
                        WorkingDirectory = workingDirectory
                    }
                },
                ct).ConfigureAwait(false);

            state.Status = attachResult.Status == "accepted" ? HostRuntimeStatus.Ready : HostRuntimeStatus.Error;
            state.LastError = attachResult.Status == "accepted" ? null : attachResult.Message;
            if (attachResult.Status == "accepted")
            {
                EnsurePulseSessionSeeded(sessionId, profile);
            }
            return attachResult.Status == "accepted";
        }
        finally
        {
            state.Gate.Release();
        }
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
            return result.TurnStarted
                   ?? throw new InvalidOperationException("Lens host did not return turn-start metadata.");
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
            state.Status == HostRuntimeStatus.None)
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
            _ = DisposeStateAsync(state);
        }
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var state in _states.Values)
        {
            await DisposeStateAsync(state).ConfigureAwait(false);
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

    private static bool TryResolveLaunch(string profile, string mode, out HostLaunch launch)
    {
        var executableName = OperatingSystem.IsWindows() ? "mtagenthost.exe" : "mtagenthost";
        var baseDir = AppContext.BaseDirectory;
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
                    ? $"--stdio --synthetic {profile}"
                    : "--stdio");
            return true;
        }

        var repoRoot = Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", ".."));
        var devDllCandidates = new[]
        {
            Path.Combine(repoRoot, "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "mtagenthost.dll"),
            Path.Combine(repoRoot, "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "Ai.Tlbx.MidTerm.AgentHost.dll"),
            Path.Combine(repoRoot, "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "win-x64", "mtagenthost.dll"),
            Path.Combine(repoRoot, "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "win-x64", "Ai.Tlbx.MidTerm.AgentHost.dll")
        };
        var devDll = devDllCandidates.FirstOrDefault(File.Exists);
        if (!string.IsNullOrWhiteSpace(devDll))
        {
            launch = new HostLaunch(
                "dotnet",
                string.Equals(mode, SyntheticMode, StringComparison.Ordinal)
                    ? $"\"{devDll}\" --stdio --synthetic {profile}"
                    : $"\"{devDll}\" --stdio");
            return true;
        }

        launch = default;
        return false;
    }

    private HostRuntimeState GetRequiredState(string sessionId)
    {
        if (!_states.TryGetValue(sessionId, out var state) ||
            state.Process is null ||
            state.Process.HasExited ||
            state.Input is null)
        {
            throw new InvalidOperationException("Lens host runtime is not attached.");
        }

        return state;
    }

    private static async Task DisposeStateAsync(HostRuntimeState state)
    {
        foreach (var pending in state.PendingCommands.Values)
        {
            pending.TrySetException(new InvalidOperationException("Lens host runtime is shutting down."));
        }

        state.PendingCommands.Clear();

        try
        {
            if (state.Process is { HasExited: false } process)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync().ConfigureAwait(false);
            }
        }
        catch
        {
        }

        try { state.Input?.Dispose(); } catch { }
        try { state.Output?.Dispose(); } catch { }
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
        public Process? Process { get; set; }
        public StreamWriter? Input { get; set; }
        public StreamReader? Output { get; set; }
        public StreamReader? Error { get; set; }
        public Task? ReaderTask { get; set; }
        public Task? ErrorTask { get; set; }
    }

    private readonly record struct HostLaunch(string FileName, string Arguments);

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
