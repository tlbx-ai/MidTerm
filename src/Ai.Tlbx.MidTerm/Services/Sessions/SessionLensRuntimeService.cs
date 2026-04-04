using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public sealed class SessionLensRuntimeService : IAsyncDisposable
{
    private const int MaxActivityCount = 120;
    private const int MaxInlineImageBytes = 10 * 1024 * 1024;
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);
    private static readonly HashSet<string> SupportedApprovalDecisions = new(StringComparer.Ordinal)
    {
        "accept",
        "acceptForSession",
        "decline",
        "cancel"
    };
    private readonly ConcurrentDictionary<string, LensRuntimeState> _states = new(StringComparer.Ordinal);
    private readonly AiCliProfileService _profileService;
    private readonly SessionLensPulseService _pulse;
    private readonly SessionLensHostRuntimeService _hostRuntime;
    private readonly SettingsService? _settingsService;

    public SessionLensRuntimeService(
        TtyHostSessionManager sessionManager,
        AiCliProfileService profileService,
        SessionLensPulseService pulse,
        SessionLensHostRuntimeService hostRuntime,
        SettingsService? settingsService = null)
    {
        _profileService = profileService;
        _pulse = pulse;
        _hostRuntime = hostRuntime;
        _settingsService = settingsService;
        sessionManager.OnSessionClosed += Forget;
    }

    public async Task<bool> EnsureAttachedAsync(
        string sessionId,
        SessionInfoDto session,
        string? resumeThreadIdOverride = null,
        CancellationToken ct = default)
    {
        if (IsAttached(sessionId))
        {
            return true;
        }

        var profile = _profileService.NormalizeProfile(null, session);
        if (profile is not AiCliProfileService.CodexProfile and not AiCliProfileService.ClaudeProfile)
        {
            return false;
        }

        var cwd = session.CurrentDirectory;
        if (string.IsNullOrWhiteSpace(cwd) || !Directory.Exists(cwd))
        {
            return false;
        }

        if (_hostRuntime.IsEnabledFor(profile))
        {
            try
            {
                if (await _hostRuntime.EnsureAttachedAsync(sessionId, profile, session, resumeThreadIdOverride, ct).ConfigureAwait(false))
                {
                    return true;
                }

                if (IsAttached(sessionId))
                {
                    return true;
                }
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"Lens host attach failed for {sessionId}; falling back to legacy runtime. {ex.Message}");
                await _hostRuntime.DetachAsync(sessionId, ct).ConfigureAwait(false);
            }
        }

        var state = _states.GetOrAdd(sessionId, static id => new LensRuntimeState(id));
        await state.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            state.Profile = profile;
            state.WorkingDirectory = cwd;

            if (profile == AiCliProfileService.CodexProfile)
            {
                if (state.Codex is { IsConnected: true } codex && codex.Process is { HasExited: false })
                {
                    return true;
                }

                var executablePath = AiCliCommandLocator.ResolveExecutablePath(profile, session, ResolveConfiguredUserProfileDirectory());
                return await StartCodexAsync(state, executablePath, ct).ConfigureAwait(false);
            }

            if (state.Claude is not null)
            {
                state.TransportKey = "claude-stream-json";
                state.TransportLabel = "Claude stream-json runtime";
                state.Status = state.Status == LensRuntimeStatus.None ? LensRuntimeStatus.Ready : state.Status;
                return true;
            }

            state.QuickSettings = LensQuickSettings.CreateSummary(
                null,
                null,
                LensQuickSettings.PlanModeOff,
                GetClaudeDefaultPermissionMode(),
                GetClaudeDefaultPermissionMode());
            state.TransportKey = "claude-stream-json";
            state.TransportLabel = "Claude stream-json runtime";
            SetStatus(state, LensRuntimeStatus.Ready, "Claude Lens runtime is ready.");
            AppendActivity(state, "positive", "session.started", "Claude Lens runtime attached.", "Lens prompts now use Claude's structured stream-json output in this session's cwd.");
            EmitPulseSessionState(state, "session.started", "ready", "Ready", "Claude Lens runtime attached.");
            EmitPulseQuickSettingsUpdated(state, state.QuickSettings, "midterm.lens", "runtime.attach");
            return true;
        }
        finally
        {
            state.Gate.Release();
        }
    }

    public async Task DiscoverExistingSessionsAsync(
        TtyHostSessionManager sessionManager,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(sessionManager);

        var recovered = 0;
        foreach (var session in sessionManager.GetSessionList().Sessions)
        {
            ct.ThrowIfCancellationRequested();

            var profile = _profileService.NormalizeProfile(null, session);
            if (!_hostRuntime.IsEnabledFor(profile) || !_hostRuntime.MayHaveRecoverableHost(session.Id))
            {
                continue;
            }

            try
            {
                if (await _hostRuntime.RecoverExistingHostAsync(session.Id, profile, session, ct: ct).ConfigureAwait(false))
                {
                    recovered++;
                }
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"Lens runtime recovery failed for {session.Id}: {ex.Message}");
                await _hostRuntime.DetachAsync(session.Id, ct).ConfigureAwait(false);
            }
        }

        Log.Info(() => string.Create(CultureInfo.InvariantCulture, $"SessionLensRuntimeService: Recovered {recovered} owned Lens runtimes on startup."));
    }

    public bool IsAttached(string sessionId)
    {
        if (_hostRuntime.OwnsSession(sessionId))
        {
            return true;
        }

        return _states.TryGetValue(sessionId, out var state) &&
               state.Status != LensRuntimeStatus.None;
    }

    public async Task DetachAsync(string sessionId, CancellationToken ct = default)
    {
        if (_hostRuntime.OwnsSession(sessionId))
        {
            await _hostRuntime.DetachAsync(sessionId, ct).ConfigureAwait(false);
            return;
        }

        if (!_states.TryRemove(sessionId, out var state))
        {
            return;
        }

        await state.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await DisposeStateAsync(state).ConfigureAwait(false);
        }
        finally
        {
            state.Gate.Release();
        }
    }

    public bool TryGetSnapshot(string sessionId, out LensRuntimeSnapshot snapshot)
    {
        if (_hostRuntime.TryGetSnapshot(sessionId, out snapshot))
        {
            return true;
        }

        snapshot = default!;
        if (!_states.TryGetValue(sessionId, out var state))
        {
            return false;
        }

        lock (state.SyncRoot)
        {
            if (state.Status == LensRuntimeStatus.None)
            {
                return false;
            }

            snapshot = new LensRuntimeSnapshot
            {
                SessionId = state.SessionId,
                Profile = state.Profile ?? AiCliProfileService.UnknownProfile,
                TransportKey = state.TransportKey,
                TransportLabel = state.TransportLabel,
                Status = state.Status switch
                {
                    LensRuntimeStatus.Starting => "starting",
                    LensRuntimeStatus.Running => "running",
                    LensRuntimeStatus.Error => "error",
                    LensRuntimeStatus.Stopped => "stopped",
                    _ => "ready"
                },
                StatusLabel = state.Status switch
                {
                    LensRuntimeStatus.Starting => "Starting",
                    LensRuntimeStatus.Running => "Running",
                    LensRuntimeStatus.Error => "Error",
                    LensRuntimeStatus.Stopped => "Stopped",
                    _ => "Ready"
                },
                LastError = state.LastError,
                LastEventAt = state.LastEventAt,
                AssistantText = state.AssistantText,
                UnifiedDiff = state.UnifiedDiff,
                PendingQuestion = state.PendingUserInputQuestion,
                Activities = state.Activities
                    .OrderByDescending(static item => item.CreatedAt)
                    .ThenBy(static item => item.Id, StringComparer.Ordinal)
                    .ToList()
            };
            return true;
        }
    }

    public async Task<bool> TrySendPromptAsync(
        string sessionId,
        SessionPromptRequest request,
        CancellationToken ct = default)
    {
        if (_hostRuntime.OwnsSession(sessionId))
        {
            return await _hostRuntime.TrySendPromptAsync(sessionId, request, ct).ConfigureAwait(false);
        }

        if (!_states.TryGetValue(sessionId, out var state))
        {
            return false;
        }

        await state.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (state.Profile == AiCliProfileService.CodexProfile)
            {
                return await SendCodexPromptAsync(state, request, ct).ConfigureAwait(false);
            }

            if (state.Profile == AiCliProfileService.ClaudeProfile)
            {
                return await SendClaudePromptAsync(state, request, ct).ConfigureAwait(false);
            }

            return false;
        }
        finally
        {
            state.Gate.Release();
        }
    }

    public async Task<LensTurnStartResponse> StartTurnAsync(
        string sessionId,
        LensTurnRequest request,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (_hostRuntime.OwnsSession(sessionId))
        {
            return await _hostRuntime.StartTurnAsync(sessionId, request, ct).ConfigureAwait(false);
        }

        if (!_states.TryGetValue(sessionId, out var state))
        {
            throw new InvalidOperationException("Lens runtime is not attached.");
        }

        await state.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            return state.Profile switch
            {
                AiCliProfileService.CodexProfile => await StartCodexTurnAsync(state, request, ct).ConfigureAwait(false),
                AiCliProfileService.ClaudeProfile => await StartClaudeTurnAsync(state, request, ct).ConfigureAwait(false),
                _ => throw new InvalidOperationException("Lens runtime does not support turns for this provider.")
            };
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

        if (_hostRuntime.OwnsSession(sessionId))
        {
            return await _hostRuntime.InterruptTurnAsync(sessionId, request, ct).ConfigureAwait(false);
        }

        if (!_states.TryGetValue(sessionId, out var state))
        {
            throw new InvalidOperationException("Lens runtime is not attached.");
        }

        await state.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            return state.Profile switch
            {
                AiCliProfileService.CodexProfile => await InterruptCodexTurnAsync(state, request, ct).ConfigureAwait(false),
                AiCliProfileService.ClaudeProfile => throw new InvalidOperationException("Claude Lens interrupt is not wired yet."),
                _ => throw new InvalidOperationException("Lens runtime does not support interrupts for this provider.")
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

        if (_hostRuntime.OwnsSession(sessionId))
        {
            return await _hostRuntime.ResolveRequestAsync(sessionId, requestId, request, ct).ConfigureAwait(false);
        }

        if (!_states.TryGetValue(sessionId, out var state))
        {
            throw new InvalidOperationException("Lens runtime is not attached.");
        }

        await state.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            return state.Profile switch
            {
                AiCliProfileService.CodexProfile => await ResolveCodexRequestAsync(state, requestId, request, ct).ConfigureAwait(false),
                AiCliProfileService.ClaudeProfile => throw new InvalidOperationException("Claude Lens approvals are not wired yet."),
                _ => throw new InvalidOperationException("Lens runtime does not support request resolution for this provider.")
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

        if (_hostRuntime.OwnsSession(sessionId))
        {
            return await _hostRuntime.ResolveUserInputAsync(sessionId, requestId, request, ct).ConfigureAwait(false);
        }

        if (!_states.TryGetValue(sessionId, out var state))
        {
            throw new InvalidOperationException("Lens runtime is not attached.");
        }

        await state.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            return state.Profile switch
            {
                AiCliProfileService.CodexProfile => await ResolveCodexUserInputAsync(state, requestId, request, ct).ConfigureAwait(false),
                AiCliProfileService.ClaudeProfile => throw new InvalidOperationException("Claude Lens user-input requests are not wired yet."),
                _ => throw new InvalidOperationException("Lens runtime does not support user-input resolution for this provider.")
            };
        }
        finally
        {
            state.Gate.Release();
        }
    }

    public void Forget(string sessionId)
    {
        _hostRuntime.Forget(sessionId);
        if (_states.TryRemove(sessionId, out var state))
        {
            _ = DisposeStateAsync(state);
        }

        _pulse.Forget(sessionId);
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var state in _states.Values)
        {
            await DisposeStateAsync(state).ConfigureAwait(false);
        }

        _states.Clear();
    }

    private async Task<bool> StartCodexAsync(LensRuntimeState state, string? executablePath, CancellationToken ct)
    {
        var binaryPath = executablePath ?? FindExecutableInPath("codex");
        if (binaryPath is null)
        {
            SetStatus(state, LensRuntimeStatus.Error, "Codex CLI was not found on PATH.");
            AppendActivity(state, "attention", "runtime.error", "Lens could not start Codex.", "The Codex CLI is not available on PATH.");
            EmitPulseRuntimeMessage(state, "runtime.error", "Codex CLI was not found on PATH.", "The Codex CLI is not available on PATH.");
            return false;
        }

        if (state.Codex is not null)
        {
            await DisposeCodexAsync(state).ConfigureAwait(false);
        }

        try
        {
            state.Codex = CodexLensRuntime.StartOwned(
                binaryPath,
                "app-server",
                state.WorkingDirectory!,
                ResolvePreferredUserProfileDirectory(binaryPath),
                state.QuickSettings.PermissionMode);
        }
        catch (InvalidOperationException)
        {
            SetStatus(state, LensRuntimeStatus.Error, "Codex app-server could not be started.");
            AppendActivity(state, "attention", "runtime.error", "Lens could not start Codex.", "The Codex app-server process failed to start.");
            EmitPulseRuntimeMessage(state, "runtime.error", "Codex app-server could not be started.", "The Codex app-server process failed to start.");
            return false;
        }
        state.QuickSettings = LensQuickSettings.CreateSummary(
            null,
            null,
            LensQuickSettings.PlanModeOff,
            GetCodexDefaultPermissionMode(),
            GetCodexDefaultPermissionMode());
        state.TransportKey = "codex-app-server";
        state.TransportLabel = "Codex app-server runtime";
        SetStatus(state, LensRuntimeStatus.Starting, "Starting Codex Lens runtime.");
        AppendActivity(state, "info", "session.started", "Codex Lens runtime starting.", "Lens is launching a native Codex app-server in this session's cwd while the terminal surface remains separate.");
        EmitPulseSessionState(state, "session.started", "starting", "Starting", "Starting Codex Lens runtime.");

        var codex = state.Codex!;
        codex.ReaderTask = Task.Run(() => ReadCodexLoopAsync(state, codex, CancellationToken.None), CancellationToken.None);
        codex.ErrorTask = Task.Run(() => ReadCodexErrorLoopAsync(state, codex, CancellationToken.None), CancellationToken.None);
        codex.Process!.Exited += (_, _) =>
        {
            lock (state.SyncRoot)
            {
                if (state.Status is LensRuntimeStatus.Error or LensRuntimeStatus.Stopped)
                {
                    return;
                }

                var exitCode = codex.Process?.ExitCode ?? -1;
                SetStatus(state, exitCode == 0 ? LensRuntimeStatus.Stopped : LensRuntimeStatus.Error,
                    exitCode == 0
                        ? "Codex Lens runtime exited."
                        : $"Codex Lens runtime exited with code {exitCode.ToString(CultureInfo.InvariantCulture)}.");
                AppendActivity(
                    state,
                    exitCode == 0 ? "warning" : "attention",
                    "session.exited",
                    "Codex Lens runtime exited.",
                    $"Exit code {exitCode.ToString(CultureInfo.InvariantCulture)}.");
            }
        };

        try
        {
            await SendCodexRequestAsync(
                state,
                "initialize",
                static id => BuildCodexInitializeRequest(id),
                ct).ConfigureAwait(false);

            await WriteCodexMessageAsync(state, BuildCodexInitializedNotification(), ct).ConfigureAwait(false);

            var threadResult = await SendCodexRequestAsync(
                state,
                "thread/start",
                id => BuildCodexThreadStartRequest(id, state.WorkingDirectory!, state.QuickSettings.PermissionMode),
                ct).ConfigureAwait(false);

            var providerThreadId = GetString(threadResult, "thread", "id") ?? GetString(threadResult, "threadId");
            if (string.IsNullOrWhiteSpace(providerThreadId))
            {
                throw new InvalidOperationException("Codex thread/start did not return a thread id.");
            }

            state.Codex.ProviderThreadId = providerThreadId;
            SetStatus(state, LensRuntimeStatus.Ready, "Codex Lens runtime ready.");
            AppendActivity(state, "positive", "thread.started", "Codex Lens runtime attached.", $"Connected to provider thread `{providerThreadId}`.");
            EmitPulseSessionState(state, "session.ready", "ready", "Ready", "Codex Lens runtime ready.");
            EmitPulseThreadState(state, "thread.started", "active", "Active", providerThreadId);
            EmitPulseQuickSettingsUpdated(state, state.QuickSettings, "midterm.lens", "runtime.attach");
            return true;
        }
        catch (Exception ex)
        {
            SetStatus(state, LensRuntimeStatus.Error, ex.Message);
            AppendActivity(state, "attention", "runtime.error", "Lens failed to attach Codex.", ex.Message);
            EmitPulseRuntimeMessage(state, "runtime.error", ex.Message, ex.Message);
            await DisposeCodexAsync(state).ConfigureAwait(false);
            return false;
        }
    }

    private async Task<bool> SendCodexPromptAsync(
        LensRuntimeState state,
        SessionPromptRequest request,
        CancellationToken ct)
    {
        var codex = state.Codex;
        if (codex is null || codex.Process is null || codex.Process.HasExited || string.IsNullOrWhiteSpace(codex.ProviderThreadId))
        {
            return false;
        }

        if (codex.PendingUserInputs.Count > 0)
        {
            var pending = codex.PendingUserInputs.Values.OrderBy(static item => item.CreatedAt).First();
            var answers = pending.QuestionIds.Count == 0
                ? new Dictionary<string, CodexQuestionAnswer>(StringComparer.Ordinal)
                : pending.QuestionIds.ToDictionary(
                    static questionId => questionId,
                    _ => new CodexQuestionAnswer { Answers = [request.Text ?? string.Empty] },
                    StringComparer.Ordinal);

            await WriteCodexMessageAsync(state, BuildCodexUserInputResponse(pending.JsonRpcId, answers), ct).ConfigureAwait(false);

            codex.PendingUserInputs.TryRemove(pending.RequestId, out _);
            state.PendingUserInputQuestion = codex.PendingUserInputs.Count == 0
                ? null
                : codex.PendingUserInputs.Values.OrderBy(static item => item.CreatedAt).First().Summary;
            AppendActivity(state, "positive", "user-input.resolved", "Answered Codex user-input request.", pending.Summary);
            EmitPulseUserInputResolved(state, pending.RequestId, pending.TurnId, pending.ItemId, answers);
            return true;
        }

        state.AssistantText = string.Empty;
        state.UnifiedDiff = null;
        SetStatus(state, LensRuntimeStatus.Running, "Codex is processing the Lens prompt.");
        AppendActivity(state, "info", "turn.started", "Sent prompt to Codex Lens runtime.", SummarizePrompt(request.Text));
        var turnInput = CreateCodexTurnInput(request.Text, [], state.QuickSettings.PlanMode);
        var turnResult = await SendCodexRequestAsync(
            state,
            "turn/start",
            id => BuildCodexTurnStartRequest(
                id,
                codex.ProviderThreadId!,
                turnInput,
                state.QuickSettings.Model,
                state.QuickSettings.Effort),
            ct).ConfigureAwait(false);
        state.Codex!.ActiveTurnId = GetString(turnResult, "turn", "id");
        return true;
    }

    private async Task<LensTurnStartResponse> StartCodexTurnAsync(
        LensRuntimeState state,
        LensTurnRequest request,
        CancellationToken ct)
    {
        var codex = state.Codex;
        if (codex is null || codex.Process is null || codex.Process.HasExited || string.IsNullOrWhiteSpace(codex.ProviderThreadId))
        {
            throw new InvalidOperationException("Codex Lens runtime is not attached.");
        }

        if (codex.PendingUserInputs.Count > 0)
        {
            throw new InvalidOperationException("Codex is waiting for structured user input. Resolve that request before starting another turn.");
        }

        if (codex.PendingApprovals.Count > 0)
        {
            throw new InvalidOperationException("Codex is waiting for approval. Resolve the pending request before starting another turn.");
        }

        var quickSettings = CreateCodexQuickSettings(request);
        if (!string.Equals(codex.PermissionMode, quickSettings.PermissionMode, StringComparison.Ordinal))
        {
            var resumeResult = await SendCodexRequestAsync(
                state,
                "thread/resume",
                id => BuildCodexThreadResumeRequest(
                    id,
                    codex.ProviderThreadId!,
                    state.WorkingDirectory!,
                    quickSettings.PermissionMode),
                ct).ConfigureAwait(false);
            codex.ProviderThreadId = GetString(resumeResult, "thread", "id")
                                     ?? GetString(resumeResult, "threadId")
                                     ?? codex.ProviderThreadId;
        }

        var turnInput = await CreateCodexTurnInputAsync(request, quickSettings.PlanMode, ct).ConfigureAwait(false);
        if (turnInput.Count == 0)
        {
            throw new InvalidOperationException("Lens turn input must include text or attachments.");
        }

        state.AssistantText = string.Empty;
        state.UnifiedDiff = null;
        SetStatus(state, LensRuntimeStatus.Running, "Codex is processing the Lens turn.");
        AppendActivity(state, "info", "turn.started", "Sent turn to Codex Lens runtime.", SummarizePrompt(request.Text));
        var turnResult = await SendCodexRequestAsync(
            state,
            "turn/start",
            id => BuildCodexTurnStartRequest(
                id,
                codex.ProviderThreadId!,
                turnInput,
                quickSettings.Model,
                quickSettings.Effort),
            ct).ConfigureAwait(false);

        var turnId = GetString(turnResult, "turn", "id");
        codex.ActiveTurnId = turnId;
        codex.PermissionMode = quickSettings.PermissionMode;
        state.QuickSettings = quickSettings;
        EmitPulseQuickSettingsUpdated(state, quickSettings, "midterm.lens", "turn.start");
        EmitSubmittedUserTurn(state, turnId, request);
        return new LensTurnStartResponse
        {
            SessionId = state.SessionId,
            Provider = AiCliProfileService.CodexProfile,
            ThreadId = codex.ProviderThreadId,
            TurnId = turnId,
            Status = "accepted",
            QuickSettings = CloneQuickSettingsSummary(quickSettings)
        };
    }

    private async Task<bool> SendClaudePromptAsync(
        LensRuntimeState state,
        SessionPromptRequest request,
        CancellationToken ct)
    {
        var binaryPath = FindExecutableInPath("claude");
        if (binaryPath is null)
        {
            SetStatus(state, LensRuntimeStatus.Error, "Claude CLI was not found on PATH.");
            AppendActivity(state, "attention", "runtime.error", "Lens could not start Claude.", "The Claude CLI is not available on PATH.");
            return false;
        }

        var existingClaude = state.Claude;
        if (existingClaude?.ActiveProcess is { HasExited: false })
        {
            return false;
        }

        var args = new List<string>
        {
            "-p",
            "--verbose",
            "--output-format",
            "stream-json",
            "--include-partial-messages"
        };
        if (string.Equals(
                state.QuickSettings.PermissionMode,
                LensQuickSettings.PermissionModeAuto,
                StringComparison.Ordinal))
        {
            args.Add("--dangerously-skip-permissions");
        }
        if (!string.IsNullOrWhiteSpace(existingClaude?.ResumeSessionId))
        {
            args.Add("--resume");
            args.Add(existingClaude.ResumeSessionId);
        }

        if (!string.IsNullOrWhiteSpace(state.QuickSettings.Model))
        {
            args.Add("--model");
            args.Add(state.QuickSettings.Model);
        }

        if (!string.IsNullOrWhiteSpace(state.QuickSettings.Effort))
        {
            args.Add("--effort");
            args.Add(state.QuickSettings.Effort);
        }

        try
        {
            var nextClaude = ClaudeLensRuntime.StartOwned(
                binaryPath,
                args,
                state.WorkingDirectory!,
                ResolvePreferredUserProfileDirectory(binaryPath),
                existingClaude?.ResumeSessionId);
            state.Claude = nextClaude;
            existingClaude?.Dispose();
        }
        catch (InvalidOperationException)
        {
            SetStatus(state, LensRuntimeStatus.Error, "Claude print-mode process could not be started.");
            AppendActivity(state, "attention", "runtime.error", "Lens could not start Claude.", "The Claude process failed to start.");
            return false;
        }
        var claude = state.Claude!;
        state.TransportKey = "claude-stream-json";
        state.TransportLabel = "Claude stream-json runtime";
        state.AssistantText = string.Empty;
        state.UnifiedDiff = null;
        SetStatus(state, LensRuntimeStatus.Running, "Claude is processing the Lens prompt.");
        AppendActivity(state, "info", "turn.started", "Sent prompt to Claude Lens runtime.", SummarizePrompt(request.Text));

        claude.ReaderTask = Task.Run(() => ReadClaudeLoopAsync(state, claude, CancellationToken.None), CancellationToken.None);
        claude.ErrorTask = Task.Run(() => ReadClaudeErrorLoopAsync(state, claude, CancellationToken.None), CancellationToken.None);
        await claude.Input!.WriteLineAsync(
            LensQuickSettings.ApplyPlanModePrompt(request.Text, state.QuickSettings.PlanMode)).ConfigureAwait(false);
        await claude.Input.FlushAsync(ct).ConfigureAwait(false);
        claude.Input.Close();

        return true;
    }

    private async Task<LensTurnStartResponse> StartClaudeTurnAsync(
        LensRuntimeState state,
        LensTurnRequest request,
        CancellationToken ct)
    {
        var quickSettings = CreateClaudeQuickSettings(request);
        state.QuickSettings = quickSettings;

        var promptRequest = new SessionPromptRequest
        {
            Text = BuildClaudePromptInput(request, quickSettings.PlanMode)
        };

        if (!await SendClaudePromptAsync(state, promptRequest, ct).ConfigureAwait(false))
        {
            throw new InvalidOperationException("Claude Lens runtime is not attached.");
        }

        EmitPulseQuickSettingsUpdated(state, quickSettings, "midterm.lens", "turn.start");

        return new LensTurnStartResponse
        {
            SessionId = state.SessionId,
            Provider = AiCliProfileService.ClaudeProfile,
            ThreadId = state.Claude?.ResumeSessionId ?? state.SessionId,
            Status = "accepted",
            QuickSettings = CloneQuickSettingsSummary(quickSettings)
        };
    }

    private async Task<LensCommandAcceptedResponse> InterruptCodexTurnAsync(
        LensRuntimeState state,
        LensInterruptRequest request,
        CancellationToken ct)
    {
        var codex = state.Codex;
        if (codex is null || codex.Process is null || codex.Process.HasExited || string.IsNullOrWhiteSpace(codex.ProviderThreadId))
        {
            throw new InvalidOperationException("Codex Lens runtime is not attached.");
        }

        var turnId = string.IsNullOrWhiteSpace(request.TurnId) ? codex.ActiveTurnId : request.TurnId;
        if (string.IsNullOrWhiteSpace(turnId))
        {
            throw new InvalidOperationException("Codex does not have an active turn to interrupt.");
        }

        await SendCodexRequestAsync(
            state,
            "turn/interrupt",
            id => BuildCodexTurnInterruptRequest(id, codex.ProviderThreadId!, turnId),
            ct).ConfigureAwait(false);

        AppendActivity(state, "warning", "turn.interrupt.requested", "Asked Codex to interrupt the active turn.", turnId);
        return new LensCommandAcceptedResponse
        {
            SessionId = state.SessionId,
            Status = "accepted",
            TurnId = turnId
        };
    }

    private async Task<LensCommandAcceptedResponse> ResolveCodexRequestAsync(
        LensRuntimeState state,
        string requestId,
        LensRequestDecisionRequest request,
        CancellationToken ct)
    {
        var decision = NormalizeApprovalDecision(request.Decision);
        var codex = state.Codex;
        if (codex is null)
        {
            throw new InvalidOperationException("Codex Lens runtime is not attached.");
        }

        if (!codex.PendingApprovals.TryRemove(requestId, out var pending))
        {
            throw new InvalidOperationException($"Unknown pending approval request: {requestId}");
        }

        await WriteCodexMessageAsync(state, BuildCodexApprovalResponse(pending.JsonRpcId, decision), ct).ConfigureAwait(false);
        AppendActivity(state, decision.StartsWith("accept", StringComparison.Ordinal) ? "positive" : "warning", "request.resolved", $"Resolved {pending.RequestTypeLabel}.", decision);
        EmitPulseRequestResolved(state, requestId, pending.RequestType, decision, pending.TurnId, pending.ItemId);
        return new LensCommandAcceptedResponse
        {
            SessionId = state.SessionId,
            Status = "accepted",
            RequestId = requestId
        };
    }

    private async Task<LensCommandAcceptedResponse> ResolveCodexUserInputAsync(
        LensRuntimeState state,
        string requestId,
        LensUserInputAnswerRequest request,
        CancellationToken ct)
    {
        var codex = state.Codex;
        if (codex is null)
        {
            throw new InvalidOperationException("Codex Lens runtime is not attached.");
        }

        if (!codex.PendingUserInputs.TryRemove(requestId, out var pending))
        {
            throw new InvalidOperationException($"Unknown pending user-input request: {requestId}");
        }

        var answers = ToCodexQuestionAnswers(pending, request.Answers);
        await WriteCodexMessageAsync(state, BuildCodexUserInputResponse(pending.JsonRpcId, answers), ct).ConfigureAwait(false);

        state.PendingUserInputQuestion = codex.PendingUserInputs.Count == 0
            ? null
            : codex.PendingUserInputs.Values.OrderBy(static item => item.CreatedAt).First().Summary;
        AppendActivity(state, "positive", "user-input.resolved", "Answered Codex user-input request.", pending.Summary);
        EmitPulseUserInputResolved(state, requestId, pending.TurnId, pending.ItemId, answers);
        return new LensCommandAcceptedResponse
        {
            SessionId = state.SessionId,
            Status = "accepted",
            RequestId = requestId
        };
    }

    private async Task ReadCodexLoopAsync(LensRuntimeState state, CodexLensRuntime codex, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested && codex.Process is { HasExited: false })
            {
                var line = await codex.Output!.ReadLineAsync(ct).ConfigureAwait(false);
                if (line is null)
                {
                    break;
                }

                HandleCodexLine(state, codex, line);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            lock (state.SyncRoot)
            {
                SetStatus(state, LensRuntimeStatus.Error, ex.Message);
                AppendActivity(state, "attention", "runtime.error", "Codex Lens stream failed.", ex.Message);
            }
        }
    }

    private static string BuildCodexInitializeRequest(string id)
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", id);
            writer.WriteString("method", "initialize");
            writer.WritePropertyName("params");
            writer.WriteStartObject();
            writer.WritePropertyName("clientInfo");
            writer.WriteStartObject();
            writer.WriteString("name", "midterm");
            writer.WriteString("title", "MidTerm Lens");
            writer.WriteString("version", "dev");
            writer.WriteEndObject();
            writer.WritePropertyName("capabilities");
            writer.WriteStartObject();
            writer.WriteBoolean("experimentalApi", true);
            writer.WriteEndObject();
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private static string BuildCodexInitializedNotification()
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("method", "initialized");
            writer.WriteEndObject();
        });
    }

    private static string BuildCodexThreadStartRequest(string id, string cwd, string permissionMode)
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", id);
            writer.WriteString("method", "thread/start");
            writer.WritePropertyName("params");
            writer.WriteStartObject();
            writer.WriteString("cwd", cwd);
            writer.WriteString("approvalPolicy", ResolveCodexApprovalPolicy(permissionMode));
            writer.WriteString("sandbox", ResolveCodexSandbox(permissionMode));
            writer.WriteBoolean("experimentalRawEvents", false);
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private static string BuildCodexThreadResumeRequest(
        string id,
        string threadId,
        string cwd,
        string permissionMode)
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", id);
            writer.WriteString("method", "thread/resume");
            writer.WritePropertyName("params");
            writer.WriteStartObject();
            writer.WriteString("threadId", threadId);
            writer.WriteString("cwd", cwd);
            writer.WriteString("approvalPolicy", ResolveCodexApprovalPolicy(permissionMode));
            writer.WriteString("sandbox", ResolveCodexSandbox(permissionMode));
            writer.WriteBoolean("persistExtendedHistory", false);
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private static string BuildCodexTurnStartRequest(
        string id,
        string threadId,
        IReadOnlyList<CodexTurnInputEntry> input,
        string? model = null,
        string? effort = null)
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", id);
            writer.WriteString("method", "turn/start");
            writer.WritePropertyName("params");
            writer.WriteStartObject();
            writer.WriteString("threadId", threadId);
            writer.WritePropertyName("input");
            writer.WriteStartArray();
            foreach (var entry in input)
            {
                writer.WriteStartObject();
                writer.WriteString("type", entry.Type);
                if (string.Equals(entry.Type, "image", StringComparison.Ordinal))
                {
                    writer.WriteString("url", entry.Url);
                }
                else
                {
                    writer.WriteString("text", entry.Text);
                    writer.WritePropertyName("text_elements");
                    writer.WriteStartArray();
                    writer.WriteEndArray();
                }
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            if (!string.IsNullOrWhiteSpace(model))
            {
                writer.WriteString("model", model);
            }

            if (!string.IsNullOrWhiteSpace(effort))
            {
                writer.WriteString("effort", effort);
            }
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private static string BuildCodexTurnInterruptRequest(string id, string threadId, string turnId)
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", id);
            writer.WriteString("method", "turn/interrupt");
            writer.WritePropertyName("params");
            writer.WriteStartObject();
            writer.WriteString("threadId", threadId);
            writer.WriteString("turnId", turnId);
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private static string BuildCodexUserInputResponse(
        string jsonRpcId,
        IReadOnlyDictionary<string, CodexQuestionAnswer> answers)
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", jsonRpcId);
            writer.WritePropertyName("result");
            writer.WriteStartObject();
            writer.WritePropertyName("answers");
            writer.WriteStartObject();
            foreach (var pair in answers)
            {
                writer.WritePropertyName(pair.Key);
                writer.WriteStartObject();
                writer.WritePropertyName("answers");
                writer.WriteStartArray();
                foreach (var answer in pair.Value.Answers)
                {
                    writer.WriteStringValue(answer);
                }
                writer.WriteEndArray();
                writer.WriteEndObject();
            }
            writer.WriteEndObject();
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private static string BuildCodexApprovalResponse(string jsonRpcId, string decision)
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", jsonRpcId);
            writer.WritePropertyName("result");
            writer.WriteStartObject();
            writer.WriteString("decision", decision);
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private static string BuildCodexUnsupportedRequestResponse(string jsonRpcId, string method)
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", jsonRpcId);
            writer.WritePropertyName("error");
            writer.WriteStartObject();
            writer.WriteNumber("code", -32601);
            writer.WriteString("message", $"Unsupported Codex server request: {method}");
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private static List<CodexTurnInputEntry> CreateCodexTurnInput(
        string? text,
        IReadOnlyList<string> fileReferences,
        string? planMode)
    {
        var effectiveText = LensQuickSettings.ApplyPlanModePrompt(text, planMode);
        if (fileReferences.Count > 0)
        {
            var fileReferenceBlock = new StringBuilder();
            fileReferenceBlock.AppendLine(fileReferences.Count == 1 ? "Attached file:" : $"Attached files ({fileReferences.Count.ToString(CultureInfo.InvariantCulture)}):");
            foreach (var fileReference in fileReferences)
            {
                fileReferenceBlock.Append("- ");
                fileReferenceBlock.AppendLine(fileReference);
            }

            effectiveText = string.IsNullOrWhiteSpace(effectiveText)
                ? fileReferenceBlock.ToString().Trim()
                : effectiveText + Environment.NewLine + Environment.NewLine + fileReferenceBlock.ToString().Trim();
        }

        var input = new List<CodexTurnInputEntry>();
        if (!string.IsNullOrWhiteSpace(effectiveText))
        {
            input.Add(new CodexTurnInputEntry
            {
                Type = "text",
                Text = effectiveText
            });
        }

        return input;
    }

    private static async Task<List<CodexTurnInputEntry>> CreateCodexTurnInputAsync(
        LensTurnRequest request,
        string? planMode,
        CancellationToken ct)
    {
        var fileReferences = new List<string>();
        var imageEntries = new List<CodexTurnInputEntry>();

        foreach (var attachment in request.Attachments)
        {
            if (string.IsNullOrWhiteSpace(attachment.Path))
            {
                continue;
            }

            if (!File.Exists(attachment.Path))
            {
                throw new InvalidOperationException($"Lens attachment does not exist: {attachment.Path}");
            }

            if (string.Equals(attachment.Kind, "image", StringComparison.OrdinalIgnoreCase))
            {
                var fileInfo = new FileInfo(attachment.Path);
                if (fileInfo.Length > MaxInlineImageBytes)
                {
                    throw new InvalidOperationException($"Lens image attachment exceeds {MaxInlineImageBytes.ToString(CultureInfo.InvariantCulture)} bytes: {attachment.Path}");
                }

                var bytes = await File.ReadAllBytesAsync(attachment.Path, ct).ConfigureAwait(false);
                var mimeType = ResolveAttachmentMimeType(attachment);
                imageEntries.Add(new CodexTurnInputEntry
                {
                    Type = "image",
                    Url = $"data:{mimeType};base64,{Convert.ToBase64String(bytes)}"
                });
                continue;
            }

            fileReferences.Add(attachment.Path);
        }

        var input = CreateCodexTurnInput(request.Text, fileReferences, planMode);
        input.AddRange(imageEntries);
        return input;
    }

    private static string BuildClaudePromptInput(LensTurnRequest request, string? planMode)
    {
        var builder = new StringBuilder();
        var text = LensQuickSettings.ApplyPlanModePrompt(request.Text, planMode);
        if (!string.IsNullOrWhiteSpace(text))
        {
            builder.AppendLine(text);
        }

        if (request.Attachments.Count > 0)
        {
            if (builder.Length > 0)
            {
                builder.AppendLine();
            }

            builder.AppendLine(request.Attachments.Count == 1
                ? "Attached resource:"
                : $"Attached resources ({request.Attachments.Count.ToString(CultureInfo.InvariantCulture)}):");
            foreach (var attachment in request.Attachments)
            {
                if (string.IsNullOrWhiteSpace(attachment.Path))
                {
                    continue;
                }

                if (!File.Exists(attachment.Path))
                {
                    throw new InvalidOperationException($"Lens attachment does not exist: {attachment.Path}");
                }

                builder.Append("- ");
                builder.Append(string.Equals(attachment.Kind, "image", StringComparison.OrdinalIgnoreCase) ? "[image] " : "[file] ");
                builder.AppendLine(attachment.Path);
            }
        }

        return builder.ToString().Trim();
    }

    private static string ResolveAttachmentMimeType(LensAttachmentReference attachment)
    {
        if (!string.IsNullOrWhiteSpace(attachment.MimeType))
        {
            return attachment.MimeType;
        }

        return Path.GetExtension(attachment.Path).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".bmp" => "image/bmp",
            ".webp" => "image/webp",
            ".svg" => "image/svg+xml",
            ".tif" or ".tiff" => "image/tiff",
            ".heic" => "image/heic",
            ".heif" => "image/heif",
            ".avif" => "image/avif",
            _ => "application/octet-stream"
        };
    }

    private static List<LensAttachmentReference> CloneAttachments(
        IReadOnlyList<LensAttachmentReference>? attachments)
    {
        if (attachments is null || attachments.Count == 0)
        {
            return [];
        }

        return attachments.Select(static attachment => new LensAttachmentReference
        {
            Kind = attachment.Kind,
            Path = attachment.Path,
            MimeType = attachment.MimeType,
            DisplayName = string.IsNullOrWhiteSpace(attachment.DisplayName)
                ? Path.GetFileName(attachment.Path)
                : attachment.DisplayName
        }).ToList();
    }

    private static IReadOnlyDictionary<string, CodexQuestionAnswer> ToCodexQuestionAnswers(
        PendingCodexUserInput pending,
        IReadOnlyList<LensPulseAnsweredQuestion> answers)
    {
        var answerMap = answers
            .Where(static answer => !string.IsNullOrWhiteSpace(answer.QuestionId))
            .ToDictionary(
                static answer => answer.QuestionId,
                answer => new CodexQuestionAnswer
                {
                    Answers = answer.Answers
                        .Where(static value => !string.IsNullOrWhiteSpace(value))
                        .ToList()
                },
                StringComparer.Ordinal);

        if (pending.QuestionIds.Count == 0)
        {
            if (answerMap.Count == 0)
            {
                throw new InvalidOperationException("Lens user-input response must include at least one answer.");
            }

            return answerMap;
        }

        var resolvedAnswers = new Dictionary<string, CodexQuestionAnswer>(StringComparer.Ordinal);
        foreach (var questionId in pending.QuestionIds)
        {
            if (!answerMap.TryGetValue(questionId, out var answer) || answer.Answers.Count == 0)
            {
                throw new InvalidOperationException($"Missing answer for Lens question '{questionId}'.");
            }

            resolvedAnswers[questionId] = answer;
        }

        return resolvedAnswers;
    }

    private static string NormalizeApprovalDecision(string? decision)
    {
        var normalized = (decision ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            throw new InvalidOperationException("Lens approval decision is required.");
        }

        if (!SupportedApprovalDecisions.Contains(normalized))
        {
            throw new InvalidOperationException($"Unsupported Lens approval decision '{normalized}'.");
        }

        return normalized;
    }

    private static string BuildJsonString(Action<Utf8JsonWriter> write)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using var writer = new Utf8JsonWriter(buffer);
        write(writer);
        writer.Flush();
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private async Task ReadCodexErrorLoopAsync(LensRuntimeState state, CodexLensRuntime codex, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested && codex.Process is { HasExited: false })
            {
                var line = await codex.Error!.ReadLineAsync(ct).ConfigureAwait(false);
                if (line is null)
                {
                    break;
                }

                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                lock (state.SyncRoot)
                {
                    state.LastError = line.Trim();
                }
            }
        }
        catch
        {
        }
    }

    private void HandleCodexLine(LensRuntimeState state, CodexLensRuntime codex, string line)
    {
        using var document = JsonDocument.Parse(line);
        var root = document.RootElement;

        if (root.TryGetProperty("id", out var idElement) &&
            (root.TryGetProperty("result", out var resultElement) || root.TryGetProperty("error", out _)))
        {
            var id = idElement.ToString();
            if (codex.PendingRequests.TryRemove(id, out var pending))
            {
                if (root.TryGetProperty("error", out var errorElement))
                {
                    pending.TrySetResult(new JsonRpcReply
                    {
                        IsError = true,
                        ErrorMessage = GetString(errorElement, "message") ?? errorElement.ToString()
                    });
                }
                else
                {
                    pending.TrySetResult(new JsonRpcReply
                    {
                        Payload = resultElement.Clone()
                    });
                }
            }

            return;
        }

        if (root.TryGetProperty("method", out var methodElement) &&
            methodElement.ValueKind == JsonValueKind.String)
        {
            var method = methodElement.GetString() ?? string.Empty;
            var payload = root.TryGetProperty("params", out var paramsElement)
                ? paramsElement.Clone()
                : default;

            if (root.TryGetProperty("id", out var requestIdElement))
            {
                HandleCodexServerRequest(state, codex, method, requestIdElement.ToString(), payload);
                return;
            }

            HandleCodexNotification(state, method, payload);
        }
    }

    private void HandleCodexServerRequest(
        LensRuntimeState state,
        CodexLensRuntime codex,
        string method,
        string jsonRpcId,
        JsonElement payload)
    {
        if (method == "item/tool/requestUserInput")
        {
            var requestId = "ui-" + Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture);
            var questions = ReadCodexQuestions(payload);
            var questionIds = ReadCodexQuestionIds(payload);
            var summary = ReadCodexQuestionSummary(payload);
            codex.PendingUserInputs[requestId] = new PendingCodexUserInput
            {
                RequestId = requestId,
                JsonRpcId = jsonRpcId,
                TurnId = codex.ActiveTurnId,
                ItemId = GetString(payload, "itemId") ?? GetString(payload, "item", "id"),
                QuestionIds = questionIds,
                Summary = summary,
                CreatedAt = DateTimeOffset.UtcNow
            };
            lock (state.SyncRoot)
            {
                state.PendingUserInputQuestion = summary;
                AppendActivity(state, "attention", "user-input.requested", "Codex asked for input.", summary);
            }
            EmitPulseUserInputRequested(state, requestId, questions, "codex.app-server.request", method, payload);
            return;
        }

        if (method.Contains("requestApproval", StringComparison.OrdinalIgnoreCase))
        {
            var requestId = "approval-" + jsonRpcId;
            var requestType = method.Contains("commandExecution", StringComparison.OrdinalIgnoreCase)
                ? "command_execution_approval"
                : method.Contains("fileRead", StringComparison.OrdinalIgnoreCase)
                    ? "file_read_approval"
                    : "file_change_approval";
            var requestTypeLabel = HumanizeRequestType(requestType);
            var detail = BuildCodexItemDetail(payload);
            codex.PendingApprovals[requestId] = new PendingCodexApproval
            {
                RequestId = requestId,
                JsonRpcId = jsonRpcId,
                RequestType = requestType,
                RequestTypeLabel = requestTypeLabel,
                TurnId = codex.ActiveTurnId,
                ItemId = GetString(payload, "itemId") ?? GetString(payload, "item", "id"),
                Detail = detail
            };
            lock (state.SyncRoot)
            {
                AppendActivity(state, "attention", "approval.requested", "Codex requested approval.", detail);
            }
            EmitPulseRequestOpened(
                state,
                requestId,
                requestType,
                requestTypeLabel,
                detail,
                "codex.app-server.request",
                method,
                payload);
            return;
        }

        _ = WriteCodexMessageAsync(state, BuildCodexUnsupportedRequestResponse(jsonRpcId, method), CancellationToken.None);
    }

    private void HandleCodexNotification(LensRuntimeState state, string method, JsonElement payload)
    {
        lock (state.SyncRoot)
        {
            state.LastEventAt = DateTimeOffset.UtcNow;

            switch (method)
            {
                case "thread/started":
                {
                    var providerThreadId = GetString(payload, "thread", "id") ?? GetString(payload, "threadId");
                    if (state.Codex is not null && !string.IsNullOrWhiteSpace(providerThreadId))
                    {
                        state.Codex.ProviderThreadId = providerThreadId;
                    }
                    EmitPulseThreadState(state, "thread.started", "active", "Active", providerThreadId, "codex.app-server.notification", method, payload);
                    break;
                }

                case "thread/status/changed":
                case "thread/archived":
                case "thread/unarchived":
                case "thread/closed":
                case "thread/compacted":
                {
                    var providerThreadId = GetString(payload, "thread", "id") ?? GetString(payload, "threadId") ?? state.Codex?.ProviderThreadId;
                    if (state.Codex is not null && !string.IsNullOrWhiteSpace(providerThreadId))
                    {
                        state.Codex.ProviderThreadId = providerThreadId;
                    }

                    var threadState = ResolveCodexThreadState(method, payload);
                    EmitPulseThreadState(state, "thread.state.changed", threadState.State, threadState.StateLabel, providerThreadId, "codex.app-server.notification", method, payload);
                    if (!string.IsNullOrWhiteSpace(threadState.Detail))
                    {
                        AppendActivity(state, "info", "thread.state.changed", threadState.Message, threadState.Detail);
                        EmitPulseRuntimeMessage(state, "thread.state.changed", threadState.Message, threadState.Detail, "codex.app-server.notification", method, payload);
                    }
                    break;
                }

                case "thread/name/updated":
                {
                    var threadName = GetString(payload, "threadName") ?? GetString(payload, "thread", "name");
                    AppendActivity(state, "info", "thread.metadata.updated", "Codex thread metadata updated.", threadName);
                    EmitPulseRuntimeMessage(
                        state,
                        "thread.metadata.updated",
                        "Codex thread metadata updated.",
                        string.IsNullOrWhiteSpace(threadName) ? "The thread metadata changed." : $"Renamed to {threadName.Trim()}.",
                        "codex.app-server.notification",
                        method,
                        payload);
                    break;
                }

                case "thread/tokenUsage/updated":
                {
                    var detail = BuildCodexTokenUsageDetail(payload);
                    AppendActivity(state, "info", "thread.token-usage.updated", "Codex context window updated.", detail);
                    EmitPulseRuntimeMessage(state, "thread.token-usage.updated", "Codex context window updated.", detail, "codex.app-server.notification", method, payload);
                    break;
                }

                case "turn/started":
                {
                    state.Codex!.ActiveTurnId = GetString(payload, "turn", "id");
                    SetStatus(state, LensRuntimeStatus.Running, "Codex turn started.");
                    AppendActivity(state, "positive", "turn.started", "Codex turn started.", GetString(payload, "turn", "id"));
                    EmitPulseSessionState(state, "session.state.changed", "running", "Running", "Codex turn started.", "codex.app-server.notification", method, payload);
                    EmitPulseTurnStarted(state, GetString(payload, "turn", "id"), GetString(payload, "turn", "model"), GetString(payload, "turn", "effort"), "codex.app-server.notification", method, payload);
                    break;
                }

                case "turn/completed":
                {
                    var turnState = GetString(payload, "turn", "status") ?? "completed";
                    var errorMessage = GetString(payload, "turn", "error", "message");
                    if (state.Codex is not null)
                    {
                        state.Codex.ActiveTurnId = null;
                    }
                    SetStatus(
                        state,
                        string.Equals(turnState, "failed", StringComparison.OrdinalIgnoreCase)
                            ? LensRuntimeStatus.Error
                            : LensRuntimeStatus.Ready,
                        errorMessage ?? $"Codex turn {turnState}.");
                    AppendActivity(
                        state,
                        string.Equals(turnState, "failed", StringComparison.OrdinalIgnoreCase) ? "attention" : "positive",
                        "turn.completed",
                        $"Codex turn {turnState}.",
                        errorMessage);
                    EmitPulseTurnCompleted(state, GetString(payload, "turn", "id"), turnState, HumanizeTurnState(turnState), errorMessage, "codex.app-server.notification", method, payload);
                    EmitPulseSessionState(
                        state,
                        "session.state.changed",
                        string.Equals(turnState, "failed", StringComparison.OrdinalIgnoreCase) ? "error" : "ready",
                        string.Equals(turnState, "failed", StringComparison.OrdinalIgnoreCase) ? "Error" : "Ready",
                        errorMessage ?? $"Codex turn {turnState}.",
                        "codex.app-server.notification",
                        method,
                        payload);
                    break;
                }

                case "turn/aborted":
                {
                    if (state.Codex is not null)
                    {
                        state.Codex.ActiveTurnId = null;
                    }

                    SetStatus(state, LensRuntimeStatus.Ready, "Codex turn aborted.");
                    AppendActivity(state, "warning", "turn.aborted", "Codex turn aborted.", GetString(payload, "reason") ?? GetString(payload, "message"));
                    EmitPulseTurnCompleted(state, GetString(payload, "turnId") ?? GetString(payload, "turn", "id"), "interrupted", "Interrupted", GetString(payload, "reason") ?? GetString(payload, "message"), "codex.app-server.notification", method, payload);
                    EmitPulseSessionState(state, "session.state.changed", "ready", "Ready", "Codex turn aborted.", "codex.app-server.notification", method, payload);
                    break;
                }

                case "turn/plan/updated":
                {
                    var planText = BuildCodexPlanMarkdown(payload);
                    if (!string.IsNullOrWhiteSpace(planText))
                    {
                        EmitPulsePlanCompleted(state, GetString(payload, "turnId") ?? GetString(payload, "turn", "id") ?? state.Codex?.ActiveTurnId, planText, "codex.app-server.notification", method, payload);
                    }
                    break;
                }

                case "turn/diff/updated":
                {
                    state.UnifiedDiff = GetString(payload, "unifiedDiff") ?? GetString(payload, "diff") ?? GetString(payload, "patch");
                    AppendActivity(state, "info", "turn.diff.updated", "Codex updated the working diff.", SummarizeDiff(state.UnifiedDiff));
                    EmitPulseDiffUpdated(state, GetString(payload, "turnId") ?? GetString(payload, "turn", "id") ?? state.Codex?.ActiveTurnId, state.UnifiedDiff ?? string.Empty, "codex.app-server.notification", method, payload);
                    break;
                }

                case "item/agentMessage/delta":
                {
                    var delta = GetString(payload, "delta") ?? GetString(payload, "text") ?? string.Empty;
                    if (!string.IsNullOrEmpty(delta))
                    {
                        state.AssistantText = (state.AssistantText ?? string.Empty) + delta;
                    }
                    EmitPulseContentDelta(
                        state,
                        GetString(payload, "turnId") ?? GetString(payload, "turn", "id") ?? state.Codex?.ActiveTurnId,
                        GetString(payload, "itemId") ?? GetString(payload, "item", "id"),
                        "assistant_text",
                        delta,
                        "codex.app-server.notification",
                        method,
                        payload);
                    break;
                }

                case "item/reasoning/textDelta":
                    EmitPulseContentDelta(state, GetString(payload, "turnId") ?? GetString(payload, "turn", "id") ?? state.Codex?.ActiveTurnId, GetString(payload, "itemId") ?? GetString(payload, "item", "id"), "reasoning_text", GetString(payload, "delta") ?? GetString(payload, "text") ?? string.Empty, "codex.app-server.notification", method, payload);
                    break;

                case "item/reasoning/summaryTextDelta":
                    EmitPulseContentDelta(state, GetString(payload, "turnId") ?? GetString(payload, "turn", "id") ?? state.Codex?.ActiveTurnId, GetString(payload, "itemId") ?? GetString(payload, "item", "id"), "reasoning_summary_text", GetString(payload, "delta") ?? GetString(payload, "text") ?? string.Empty, "codex.app-server.notification", method, payload);
                    break;

                case "item/commandExecution/outputDelta":
                    EmitPulseContentDelta(state, GetString(payload, "turnId") ?? GetString(payload, "turn", "id") ?? state.Codex?.ActiveTurnId, GetString(payload, "itemId") ?? GetString(payload, "item", "id"), "command_output", GetString(payload, "delta") ?? GetString(payload, "text") ?? string.Empty, "codex.app-server.notification", method, payload);
                    break;

                case "item/fileChange/outputDelta":
                    EmitPulseContentDelta(state, GetString(payload, "turnId") ?? GetString(payload, "turn", "id") ?? state.Codex?.ActiveTurnId, GetString(payload, "itemId") ?? GetString(payload, "item", "id"), "file_change_output", GetString(payload, "delta") ?? GetString(payload, "text") ?? string.Empty, "codex.app-server.notification", method, payload);
                    break;

                case "item/plan/delta":
                {
                    var delta = GetString(payload, "delta") ?? GetString(payload, "text") ?? string.Empty;
                    if (!string.IsNullOrEmpty(delta))
                    {
                        EmitPulsePlanDelta(state, GetString(payload, "turnId") ?? GetString(payload, "turn", "id") ?? state.Codex?.ActiveTurnId, delta, "codex.app-server.notification", method, payload);
                    }
                    break;
                }

                case "item/started":
                {
                    var itemType = NormalizeCodexItemType(GetString(payload, "item", "type") ?? GetString(payload, "type"));
                    var turnId = GetString(payload, "turnId") ?? GetString(payload, "turn", "id") ?? state.Codex?.ActiveTurnId;
                    if (itemType is "command_execution" or "file_change" or "web_search" or "mcp_tool_call" or "dynamic_tool_call")
                    {
                        AppendActivity(state, "info", "tool.started", $"{PrettifyToolKind(itemType)} started.", BuildCodexItemDetail(payload));
                    }
                    EmitPulseItem(state, "item.started", turnId, GetString(payload, "item", "id") ?? GetString(payload, "itemId"), itemType, "in_progress", $"{PrettifyToolKind(itemType)} started", BuildCodexItemDetail(payload), null, "codex.app-server.notification", method, payload);
                    break;
                }

                case "item/reasoning/summaryPartAdded":
                case "item/commandExecution/terminalInteraction":
                {
                    var itemType = method == "item/commandExecution/terminalInteraction"
                        ? "command_execution"
                        : NormalizeCodexItemType(GetString(payload, "item", "type") ?? GetString(payload, "type"));
                    var detail = method == "item/commandExecution/terminalInteraction"
                        ? GetString(payload, "stdin") ?? BuildCodexItemDetail(payload)
                        : BuildCodexItemDetail(payload);
                    var title = method == "item/commandExecution/terminalInteraction"
                        ? "Command running"
                        : PrettifyToolKind(itemType);
                    EmitPulseItem(state, "item.updated", GetString(payload, "turnId") ?? GetString(payload, "turn", "id") ?? state.Codex?.ActiveTurnId, GetString(payload, "item", "id") ?? GetString(payload, "itemId"), itemType, "in_progress", title, detail, null, "codex.app-server.notification", method, payload);
                    break;
                }

                case "item/mcpToolCall/progress":
                {
                    var turnId = GetString(payload, "turnId") ?? GetString(payload, "turn", "id") ?? state.Codex?.ActiveTurnId;
                    var itemId = GetString(payload, "item", "id") ?? GetString(payload, "itemId") ?? GetString(payload, "toolUseId");
                    if (string.IsNullOrWhiteSpace(itemId))
                    {
                        break;
                    }

                    var itemType = NormalizeCodexItemType(GetString(payload, "item", "type") ?? GetString(payload, "type") ?? "mcpToolCall");
                    var title = GetString(payload, "toolName") ?? "MCP tool";
                    var detail = GetString(payload, "summary") ?? BuildCodexItemDetail(payload);
                    EmitPulseItem(
                        state,
                        "item.updated",
                        turnId,
                        itemId,
                        itemType,
                        "in_progress",
                        title,
                        detail,
                        null,
                        "codex.app-server.notification",
                        method,
                        payload);
                    break;
                }

                case "codex/event/task_started":
                {
                    var turnId = GetString(payload, "msg", "turn_id") ?? state.Codex?.ActiveTurnId;
                    var taskId = GetString(payload, "id") ?? turnId;
                    if (string.IsNullOrWhiteSpace(taskId))
                    {
                        break;
                    }

                    var taskType = GetString(payload, "msg", "collaboration_mode_kind");
                    var itemType = ResolveCodexTaskItemType(taskType);
                    var title = itemType == "plan" ? "Planning" : "Reasoning";
                    var detail = GetString(payload, "msg", "text")
                                 ?? GetString(payload, "msg", "summary")
                                 ?? GetString(payload, "msg", "last_agent_message")
                                 ?? "Codex started a task.";
                    AppendActivity(state, "info", "task.started", title, detail);
                    EmitPulseItem(state, "item.started", turnId, taskId, itemType, "in_progress", title, detail, null, "codex.eventmsg", method, payload);
                    break;
                }

                case "codex/event/agent_reasoning":
                {
                    var turnId = GetString(payload, "msg", "turn_id") ?? state.Codex?.ActiveTurnId;
                    var taskId = GetString(payload, "id") ?? turnId;
                    var detail = GetString(payload, "msg", "text");
                    if (string.IsNullOrWhiteSpace(taskId) || string.IsNullOrWhiteSpace(detail))
                    {
                        break;
                    }

                    EmitPulseItem(state, "item.updated", turnId, taskId, "reasoning", "in_progress", "Reasoning", detail, null, "codex.eventmsg", method, payload);
                    break;
                }

                case "codex/event/task_complete":
                {
                    var turnId = GetString(payload, "msg", "turn_id") ?? state.Codex?.ActiveTurnId;
                    var taskId = GetString(payload, "id") ?? turnId;
                    var taskType = GetString(payload, "msg", "collaboration_mode_kind");
                    var itemType = ResolveCodexTaskItemType(taskType);
                    var summary = GetString(payload, "msg", "last_agent_message")
                                  ?? GetString(payload, "msg", "text")
                                  ?? "Codex completed a task.";
                    if (!string.IsNullOrWhiteSpace(taskId))
                    {
                        EmitPulseItem(state, "item.completed", turnId, taskId, itemType, "completed", itemType == "plan" ? "Plan completed" : "Reasoning completed", summary, null, "codex.eventmsg", method, payload);
                    }

                    var proposedPlan = ExtractProposedPlanMarkdown(summary);
                    if (!string.IsNullOrWhiteSpace(proposedPlan))
                    {
                        EmitPulsePlanCompleted(state, turnId, proposedPlan, "codex.eventmsg", method, payload);
                    }
                    break;
                }

                case "codex/event/reasoning_content_delta":
                {
                    var delta = GetString(payload, "msg", "delta") ?? string.Empty;
                    if (!string.IsNullOrEmpty(delta))
                    {
                        var streamKind = Traverse(payload, "msg", "summary_index") is JsonElement { ValueKind: JsonValueKind.Number }
                            ? "reasoning_summary_text"
                            : "reasoning_text";
                        EmitPulseContentDelta(state, GetString(payload, "msg", "turn_id") ?? state.Codex?.ActiveTurnId, GetString(payload, "msg", "item_id"), streamKind, delta, "codex.eventmsg", method, payload);
                    }
                    break;
                }

                case "item/completed":
                {
                    var itemType = NormalizeCodexItemType(GetString(payload, "item", "type") ?? GetString(payload, "type"));
                    var turnId = GetString(payload, "turnId") ?? GetString(payload, "turn", "id") ?? state.Codex?.ActiveTurnId;
                    if (itemType is "assistant_message" or "agent_message")
                    {
                        var detail = BuildCodexItemDetail(payload);
                        if (!string.IsNullOrWhiteSpace(detail))
                        {
                            state.AssistantText = detail;
                        }
                        AppendActivity(state, "positive", "item.completed", "Assistant message completed.", Trim(detail, 220));
                        EmitPulseItem(state, "item.completed", turnId, GetString(payload, "item", "id") ?? GetString(payload, "itemId"), "assistant_message", "completed", "Assistant message", detail, null, "codex.app-server.notification", method, payload);
                    }
                    else if (itemType is "plan")
                    {
                        var detail = BuildCodexItemDetail(payload);
                        if (!string.IsNullOrWhiteSpace(detail))
                        {
                            EmitPulsePlanCompleted(state, turnId, detail, "codex.app-server.notification", method, payload);
                        }
                    }
                    else if (itemType is "command_execution" or "file_change" or "web_search" or "mcp_tool_call" or "dynamic_tool_call")
                    {
                        AppendActivity(state, "positive", "tool.completed", $"{PrettifyToolKind(itemType)} completed.", BuildCodexItemDetail(payload));
                        EmitPulseItem(state, "item.completed", turnId, GetString(payload, "item", "id") ?? GetString(payload, "itemId"), itemType, "completed", $"{PrettifyToolKind(itemType)} completed", BuildCodexItemDetail(payload), null, "codex.app-server.notification", method, payload);
                    }
                    break;
                }

                case "model/rerouted":
                {
                    EmitPulseRuntimeMessage(
                        state,
                        "model.rerouted",
                        $"Codex rerouted the model from {GetString(payload, "fromModel") ?? "unknown"} to {GetString(payload, "toModel") ?? "unknown"}.",
                        GetString(payload, "reason"),
                        "codex.app-server.notification",
                        method,
                        payload);
                    break;
                }

                case "deprecationNotice":
                {
                    EmitPulseRuntimeMessage(
                        state,
                        "deprecation.notice",
                        GetString(payload, "summary") ?? "Codex reported a deprecation notice.",
                        GetString(payload, "details"),
                        "codex.app-server.notification",
                        method,
                        payload);
                    break;
                }

                case "configWarning":
                {
                    EmitPulseRuntimeMessage(
                        state,
                        "config.warning",
                        GetString(payload, "summary") ?? "Codex reported a configuration warning.",
                        JoinNonEmpty(GetString(payload, "details"), GetString(payload, "path")),
                        "codex.app-server.notification",
                        method,
                        payload);
                    break;
                }

                case "account/updated":
                {
                    EmitPulseRuntimeMessage(state, "account.updated", "Codex account details updated.", BuildCompactJsonDetail(payload), "codex.app-server.notification", method, payload);
                    break;
                }

                case "account/rateLimits/updated":
                {
                    EmitPulseRuntimeMessage(state, "account.rate-limits.updated", "Codex rate limits updated.", BuildCompactJsonDetail(payload), "codex.app-server.notification", method, payload);
                    break;
                }

                case "mcpServer/oauthLogin/completed":
                {
                    var success = GetBoolean(payload, "success");
                    EmitPulseRuntimeMessage(
                        state,
                        "mcp.oauth.completed",
                        success ? "MCP sign-in completed." : "MCP sign-in failed.",
                        JoinNonEmpty(GetString(payload, "name"), GetString(payload, "error")),
                        "codex.app-server.notification",
                        method,
                        payload);
                    break;
                }

                case "thread/realtime/started":
                case "thread/realtime/itemAdded":
                case "thread/realtime/outputAudio/delta":
                case "thread/realtime/error":
                case "thread/realtime/closed":
                {
                    EmitPulseRuntimeMessage(state, MapRealtimeEventType(method), HumanizeRealtimeEvent(method), BuildCompactJsonDetail(payload), "codex.app-server.notification", method, payload);
                    break;
                }

                case "error":
                {
                    var message = GetString(payload, "error", "message") ?? "Codex runtime error";
                    var willRetry = GetBoolean(payload, "willRetry");
                    EmitPulseRuntimeMessage(state, willRetry ? "runtime.warning" : "runtime.error", message, willRetry ? "Codex reported that it will retry." : message, "codex.app-server.notification", method, payload);
                    break;
                }
            }
        }
    }

    private async Task ReadClaudeLoopAsync(LensRuntimeState state, ClaudeLensRuntime claude, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested && claude.ActiveProcess is { HasExited: false })
            {
                var line = await claude.Output!.ReadLineAsync(ct).ConfigureAwait(false);
                if (line is null)
                {
                    break;
                }

                HandleClaudeLine(state, claude, line);
            }

            if (claude.ActiveProcess is { ExitCode: var exitCode })
            {
                lock (state.SyncRoot)
                {
                    SetStatus(
                        state,
                        exitCode == 0 ? LensRuntimeStatus.Ready : LensRuntimeStatus.Error,
                        exitCode == 0
                            ? "Claude Lens runtime is ready for the next prompt."
                            : $"Claude Lens runtime exited with code {exitCode.ToString(CultureInfo.InvariantCulture)}.");
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            lock (state.SyncRoot)
            {
                SetStatus(state, LensRuntimeStatus.Error, ex.Message);
                AppendActivity(state, "attention", "runtime.error", "Claude Lens stream failed.", ex.Message);
            }
        }
        finally
        {
            claude.DisposeExitedProcess();
        }
    }

    private async Task ReadClaudeErrorLoopAsync(LensRuntimeState state, ClaudeLensRuntime claude, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested && claude.ActiveProcess is { HasExited: false })
            {
                var line = await claude.Error!.ReadLineAsync(ct).ConfigureAwait(false);
                if (line is null)
                {
                    break;
                }

                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                lock (state.SyncRoot)
                {
                    state.LastError = line.Trim();
                }
            }
        }
        catch
        {
        }
    }

    private void HandleClaudeLine(LensRuntimeState state, ClaudeLensRuntime claude, string line)
    {
        using var document = JsonDocument.Parse(line);
        var root = document.RootElement;
        if (!root.TryGetProperty("type", out var typeElement) || typeElement.ValueKind != JsonValueKind.String)
        {
            return;
        }

        var type = typeElement.GetString() ?? string.Empty;
        lock (state.SyncRoot)
        {
            state.LastEventAt = DateTimeOffset.UtcNow;

            switch (type)
            {
                case "system":
                {
                    claude.ResumeSessionId ??= GetString(root, "session_id");
                    AppendActivity(state, "positive", "session.started", "Claude Lens runtime attached.", "Claude is streaming structured JSON turn output for Lens.");
                    break;
                }

                case "stream_event":
                {
                    var eventType = GetString(root, "event", "type");
                    switch (eventType)
                    {
                        case "message_start":
                            SetStatus(state, LensRuntimeStatus.Running, "Claude turn started.");
                            break;
                        case "content_block_delta":
                        {
                            var delta = GetString(root, "event", "delta", "text");
                            if (!string.IsNullOrEmpty(delta))
                            {
                                state.AssistantText = (state.AssistantText ?? string.Empty) + delta;
                            }
                            break;
                        }
                    }
                    break;
                }

                case "assistant":
                {
                    claude.ResumeSessionId ??= GetString(root, "session_id");
                    var text = JoinClaudeAssistantText(root);
                    if (!string.IsNullOrWhiteSpace(text))
                    {
                        state.AssistantText = text;
                    }
                    AppendActivity(state, "positive", "item.completed", "Claude assistant message completed.", Trim(text, 220));
                    break;
                }

                case "result":
                {
                    claude.ResumeSessionId ??= GetString(root, "session_id");
                    var subtype = GetString(root, "subtype") ?? "unknown";
                    var isError = GetBoolean(root, "is_error");
                    var resultText = GetString(root, "result");
                    if (!string.IsNullOrWhiteSpace(resultText))
                    {
                        state.AssistantText = resultText;
                    }
                    SetStatus(state, isError ? LensRuntimeStatus.Error : LensRuntimeStatus.Ready, resultText ?? $"Claude turn {subtype}.");
                    AppendActivity(
                        state,
                        isError ? "attention" : "positive",
                        "turn.completed",
                        $"Claude turn {subtype}.",
                        Trim(resultText, 220));
                    break;
                }
            }
        }
    }

    private static void SetStatus(LensRuntimeState state, LensRuntimeStatus status, string? detail)
    {
        state.Status = status;
        state.LastError = status == LensRuntimeStatus.Error ? detail : state.LastError;
        state.LastEventAt = DateTimeOffset.UtcNow;
    }

    private static void AppendActivity(
        LensRuntimeState state,
        string tone,
        string kind,
        string summary,
        string? detail)
    {
        state.NextSequence++;
        state.Activities.Add(new AgentSessionVibeActivity
        {
            Id = $"n{state.NextSequence.ToString(CultureInfo.InvariantCulture)}",
            Tone = tone,
            Kind = kind,
            Summary = summary,
            Detail = string.IsNullOrWhiteSpace(detail) ? null : detail,
            CreatedAt = DateTimeOffset.UtcNow
        });

        while (state.Activities.Count > MaxActivityCount)
        {
            state.Activities.RemoveAt(0);
        }
    }

    private static async Task DisposeStateAsync(LensRuntimeState state)
    {
        try
        {
            await state.Gate.WaitAsync().ConfigureAwait(false);
            try
            {
                await DisposeCodexAsync(state).ConfigureAwait(false);
                DisposeClaude(state);
            }
            finally
            {
                state.Gate.Release();
            }
        }
        catch
        {
        }
    }

    private static async Task<JsonElement> SendCodexRequestAsync(
        LensRuntimeState state,
        string method,
        Func<string, string> messageFactory,
        CancellationToken ct)
    {
        var codex = state.Codex ?? throw new InvalidOperationException("Codex runtime is not attached.");
        var id = Interlocked.Increment(ref codex.NextRequestId).ToString(CultureInfo.InvariantCulture);
        var pending = new TaskCompletionSource<JsonRpcReply>(TaskCreationOptions.RunContinuationsAsynchronously);
        codex.PendingRequests[id] = pending;

        await WriteCodexMessageAsync(state, messageFactory(id), ct).ConfigureAwait(false);

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(20));
        await using var _ = timeoutCts.Token.Register(() => pending.TrySetCanceled(timeoutCts.Token));
        var reply = await pending.Task.ConfigureAwait(false);
        if (reply.IsError)
        {
            throw new InvalidOperationException(reply.ErrorMessage ?? $"{method} failed.");
        }

        return reply.Payload;
    }

    private static async Task WriteCodexMessageAsync(
        LensRuntimeState state,
        string payload,
        CancellationToken ct)
    {
        var codex = state.Codex ?? throw new InvalidOperationException("Codex runtime is not attached.");
        await codex.Input!.WriteLineAsync(payload.AsMemory(), ct).ConfigureAwait(false);
        await codex.Input.FlushAsync(ct).ConfigureAwait(false);
    }

    private static ProcessStartInfo CreateProcessStartInfo(
        string binaryPath,
        IReadOnlyList<string> arguments,
        string workingDirectory,
        string? profileDirectory = null)
    {
        var argumentString = string.Join(" ", arguments.Select(QuoteArgument));
        return CreateProcessStartInfo(binaryPath, argumentString, workingDirectory, profileDirectory);
    }

    private static ProcessStartInfo CreateProcessStartInfo(
        string binaryPath,
        string arguments,
        string workingDirectory,
        string? profileDirectory = null)
    {
        ProcessStartInfo startInfo;
        var extension = Path.GetExtension(binaryPath);
        if (OperatingSystem.IsWindows() &&
            (extension.Equals(".cmd", StringComparison.OrdinalIgnoreCase) ||
             extension.Equals(".bat", StringComparison.OrdinalIgnoreCase)))
        {
            var comspec = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
            startInfo = new ProcessStartInfo
            {
                FileName = comspec,
                Arguments = $"/d /c \"\"{binaryPath}\" {arguments}\"",
                WorkingDirectory = workingDirectory,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Utf8NoBom,
                StandardErrorEncoding = Utf8NoBom,
                StandardInputEncoding = Utf8NoBom
            };
        }
        else
        {
            startInfo = new ProcessStartInfo
            {
                FileName = binaryPath,
                Arguments = arguments,
                WorkingDirectory = workingDirectory,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Utf8NoBom,
                StandardErrorEncoding = Utf8NoBom,
                StandardInputEncoding = Utf8NoBom
            };
        }

        LensHostEnvironmentResolver.ApplyProfileEnvironment(startInfo, profileDirectory);
        return startInfo;
    }

    private static string QuoteArgument(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return "\"\"";
        }

        return value.IndexOfAny([' ', '\t', '"']) >= 0
            ? "\"" + value.Replace("\"", "\\\"", StringComparison.Ordinal) + "\""
            : value;
    }

    private string? FindExecutableInPath(string commandName)
    {
        return AiCliCommandLocator.FindExecutableInPath(commandName, ResolveConfiguredUserProfileDirectory());
    }

    private string? ResolvePreferredUserProfileDirectory(string? executablePath)
    {
        if (!OperatingSystem.IsWindows())
        {
            return null;
        }

        return ResolveConfiguredUserProfileDirectory()
               ?? LensHostEnvironmentResolver.ResolveWindowsProfileDirectoryFromExecutablePath(executablePath)
               ?? LensHostEnvironmentResolver.ResolveCurrentWindowsProfileDirectory();
    }

    private string? ResolveConfiguredUserProfileDirectory()
    {
        var settings = _settingsService?.Load();
        if (settings is null || !OperatingSystem.IsWindows() || string.IsNullOrWhiteSpace(settings.RunAsUser))
        {
            return null;
        }

        return LensHostEnvironmentResolver.ResolveWindowsProfileDirectory(settings.RunAsUser, settings.RunAsUserSid);
    }

    private static string BuildCodexItemDetail(JsonElement payload)
    {
        var item = GetObject(payload, "item") ?? payload;
        return GetString(item, "detail")
               ?? GetString(item, "title")
               ?? GetString(item, "text")
               ?? GetString(item, "command")
               ?? GetString(item, "summary")
               ?? GetString(item, "kind")
               ?? string.Empty;
    }

    private static string BuildCodexPlanMarkdown(JsonElement payload)
    {
        var builder = new StringBuilder();
        var explanation = GetString(payload, "explanation");
        if (!string.IsNullOrWhiteSpace(explanation))
        {
            builder.AppendLine(explanation.Trim());
        }

        if (payload.ValueKind == JsonValueKind.Object &&
            payload.TryGetProperty("plan", out var planElement) &&
            planElement.ValueKind == JsonValueKind.Array)
        {
            for (var index = 0; index < planElement.GetArrayLength(); index++)
            {
                var step = planElement[index];
                var stepText = GetString(step, "step");
                if (string.IsNullOrWhiteSpace(stepText))
                {
                    continue;
                }

                var status = GetString(step, "status");
                if (builder.Length > 0)
                {
                    builder.AppendLine();
                }

                builder.Append("- ");
                builder.Append(stepText.Trim());
                if (!string.IsNullOrWhiteSpace(status))
                {
                    builder.Append(" [");
                    builder.Append(status.Trim());
                    builder.Append(']');
                }
            }
        }

        return builder.ToString().Trim();
    }

    private static string? ExtractProposedPlanMarkdown(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        const string startTag = "<proposed_plan>";
        const string endTag = "</proposed_plan>";
        var startIndex = value.IndexOf(startTag, StringComparison.OrdinalIgnoreCase);
        if (startIndex < 0)
        {
            return null;
        }

        startIndex += startTag.Length;
        var endIndex = value.IndexOf(endTag, startIndex, StringComparison.OrdinalIgnoreCase);
        if (endIndex < 0)
        {
            return null;
        }

        var extracted = value[startIndex..endIndex].Trim();
        return extracted.Length == 0 ? null : extracted;
    }

    private static string ResolveCodexTaskItemType(string? taskType)
    {
        return string.Equals(taskType, "plan", StringComparison.OrdinalIgnoreCase)
            ? "plan"
            : "reasoning";
    }

    private static (string State, string StateLabel, string Message, string? Detail) ResolveCodexThreadState(string method, JsonElement payload)
    {
        var state = method switch
        {
            "thread/archived" => "archived",
            "thread/unarchived" => "active",
            "thread/closed" => "closed",
            "thread/compacted" => "compacted",
            _ => GetString(payload, "thread", "state") ?? GetString(payload, "state") ?? "active"
        };

        return state switch
        {
            "idle" => ("idle", "Idle", "Codex thread is idle.", null),
            "archived" => ("archived", "Archived", "Codex thread archived.", null),
            "closed" => ("closed", "Closed", "Codex thread closed.", null),
            "compacted" => ("compacted", "Compacted", "Codex compacted the thread context.", null),
            "error" => ("error", "Error", "Codex thread entered an error state.", BuildCompactJsonDetail(payload)),
            _ => ("active", "Active", "Codex thread is active.", null)
        };
    }

    private static string BuildCodexTokenUsageDetail(JsonElement payload)
    {
        var usage = GetObject(payload, "tokenUsage") ?? payload;
        var total = GetLong(usage, "total", "total_tokens")
                    ?? GetLong(usage, "total", "totalTokens")
                    ?? GetLong(usage, "last", "total_tokens")
                    ?? GetLong(usage, "last", "totalTokens");
        var input = GetLong(usage, "last", "input_tokens") ?? GetLong(usage, "last", "inputTokens");
        var output = GetLong(usage, "last", "output_tokens") ?? GetLong(usage, "last", "outputTokens");
        var max = GetLong(usage, "model_context_window") ?? GetLong(usage, "modelContextWindow");

        var parts = new List<string>();
        if (total.HasValue)
        {
            parts.Add($"Used {total.Value.ToString(CultureInfo.InvariantCulture)} tokens");
        }

        if (max.HasValue)
        {
            parts.Add($"window {max.Value.ToString(CultureInfo.InvariantCulture)}");
        }

        if (input.HasValue || output.HasValue)
        {
            parts.Add($"last turn in/out {input.GetValueOrDefault().ToString(CultureInfo.InvariantCulture)}/{output.GetValueOrDefault().ToString(CultureInfo.InvariantCulture)}");
        }

        return parts.Count == 0 ? BuildCompactJsonDetail(payload) ?? "Token usage changed." : string.Join(", ", parts);
    }

    private static string? BuildCompactJsonDetail(JsonElement payload)
    {
        var raw = payload.ValueKind == JsonValueKind.Undefined ? null : payload.GetRawText();
        return string.IsNullOrWhiteSpace(raw) ? null : raw;
    }

    private static string? JoinNonEmpty(params string?[] values)
    {
        var filtered = values
            .Where(static value => !string.IsNullOrWhiteSpace(value))
            .Select(static value => value!.Trim())
            .ToList();
        return filtered.Count == 0 ? null : string.Join(" | ", filtered);
    }

    private static string MapRealtimeEventType(string method)
    {
        return method switch
        {
            "thread/realtime/started" => "thread.realtime.started",
            "thread/realtime/itemAdded" => "thread.realtime.item-added",
            "thread/realtime/outputAudio/delta" => "thread.realtime.audio.delta",
            "thread/realtime/error" => "thread.realtime.error",
            "thread/realtime/closed" => "thread.realtime.closed",
            _ => "runtime.warning"
        };
    }

    private static string HumanizeRealtimeEvent(string method)
    {
        return method switch
        {
            "thread/realtime/started" => "Codex realtime session started.",
            "thread/realtime/itemAdded" => "Codex realtime item added.",
            "thread/realtime/outputAudio/delta" => "Codex realtime audio updated.",
            "thread/realtime/error" => "Codex realtime session reported an error.",
            "thread/realtime/closed" => "Codex realtime session closed.",
            _ => "Codex realtime update."
        };
    }

    private static string NormalizeCodexItemType(string? value)
    {
        var normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
        return normalized switch
        {
            "agent_message" => "assistant_message",
            "command_execution" => "command_execution",
            "file_change" => "file_change",
            "web_search" => "web_search",
            "mcp_tool_call" => "mcp_tool_call",
            "assistant_message" => "assistant_message",
            _ => normalized
        };
    }

    private static string PrettifyToolKind(string itemType)
    {
        return itemType switch
        {
            "command_execution" => "Command",
            "file_change" => "File change",
            "web_search" => "Web search",
            "mcp_tool_call" => "MCP tool",
            "dynamic_tool_call" => "Tool",
            _ => "Tool"
        };
    }

    private static string ReadCodexQuestionSummary(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("questions", out var questions) ||
            questions.ValueKind != JsonValueKind.Array)
        {
            return "Codex is waiting for user input.";
        }

        for (var index = 0; index < questions.GetArrayLength(); index++)
        {
            var question = questions[index];
            var prompt = GetString(question, "question");
            if (!string.IsNullOrWhiteSpace(prompt))
            {
                return prompt;
            }
        }

        return "Codex is waiting for user input.";
    }

    private static List<string> ReadCodexQuestionIds(JsonElement payload)
    {
        var ids = new List<string>();
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("questions", out var questions) ||
            questions.ValueKind != JsonValueKind.Array)
        {
            return ids;
        }

        for (var index = 0; index < questions.GetArrayLength(); index++)
        {
            var question = questions[index];
            var id = GetString(question, "id");
            if (!string.IsNullOrWhiteSpace(id))
            {
                ids.Add(id);
            }
        }

        return ids;
    }

    private static string JoinClaudeAssistantText(JsonElement root)
    {
        if (!root.TryGetProperty("message", out var message) ||
            !message.TryGetProperty("content", out var content) ||
            content.ValueKind != JsonValueKind.Array)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        for (var index = 0; index < content.GetArrayLength(); index++)
        {
            var item = content[index];
            var type = GetString(item, "type");
            if (!string.Equals(type, "text", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            builder.Append(GetString(item, "text"));
        }

        return builder.ToString();
    }

    private static string SummarizePrompt(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var flattened = string.Join(" ", text
            .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        return Trim(flattened, 220);
    }

    private static string? SummarizeDiff(string? diff)
    {
        if (string.IsNullOrWhiteSpace(diff))
        {
            return null;
        }

        var line = diff
            .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .FirstOrDefault();
        return Trim(line, 220);
    }

    private static string Trim(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        var trimmed = value.Trim();
        return trimmed.Length <= maxLength
            ? trimmed
            : trimmed[..(maxLength - 3)] + "...";
    }

    private void EmitPulseSessionState(
        LensRuntimeState state,
        string eventType,
        string sessionState,
        string stateLabel,
        string? reason,
        string rawSource = "midterm.lens",
        string? rawMethod = null,
        JsonElement payload = default)
    {
        EmitPulseEvent(state, eventType, rawSource, rawMethod, payload, lensEvent =>
        {
            lensEvent.SessionState = new LensPulseSessionStatePayload
            {
                State = sessionState,
                StateLabel = stateLabel,
                Reason = reason
            };
        });
    }

    private void EmitPulseThreadState(
        LensRuntimeState state,
        string eventType,
        string threadState,
        string stateLabel,
        string? providerThreadId,
        string rawSource = "midterm.lens",
        string? rawMethod = null,
        JsonElement payload = default)
    {
        EmitPulseEvent(state, eventType, rawSource, rawMethod, payload, lensEvent =>
        {
            lensEvent.ThreadState = new LensPulseThreadStatePayload
            {
                State = threadState,
                StateLabel = stateLabel,
                ProviderThreadId = providerThreadId
            };
        });
    }

    private void EmitPulseQuickSettingsUpdated(
        LensRuntimeState state,
        LensQuickSettingsSummary quickSettings,
        string rawSource,
        string? rawMethod)
    {
        EmitPulseEvent(state, "quick-settings.updated", rawSource, rawMethod, default, lensEvent =>
        {
            lensEvent.QuickSettingsUpdated = LensQuickSettings.ToPayload(quickSettings);
        });
    }

    private void EmitPulseTurnStarted(
        LensRuntimeState state,
        string? turnId,
        string? model,
        string? effort,
        string rawSource,
        string rawMethod,
        JsonElement payload)
    {
        EmitPulseEvent(state, "turn.started", rawSource, rawMethod, payload, lensEvent =>
        {
            lensEvent.TurnId = turnId;
            lensEvent.TurnStarted = new LensPulseTurnStartedPayload
            {
                Model = model,
                Effort = effort
            };
        });
    }

    private void EmitPulseTurnCompleted(
        LensRuntimeState state,
        string? turnId,
        string turnState,
        string stateLabel,
        string? errorMessage,
        string rawSource,
        string rawMethod,
        JsonElement payload)
    {
        EmitPulseEvent(state, "turn.completed", rawSource, rawMethod, payload, lensEvent =>
        {
            lensEvent.TurnId = turnId;
            lensEvent.TurnCompleted = new LensPulseTurnCompletedPayload
            {
                State = turnState,
                StateLabel = stateLabel,
                ErrorMessage = errorMessage
            };
        });
    }

    private void EmitPulseContentDelta(
        LensRuntimeState state,
        string? turnId,
        string? itemId,
        string streamKind,
        string delta,
        string rawSource,
        string rawMethod,
        JsonElement payload)
    {
        if (string.IsNullOrEmpty(delta))
        {
            return;
        }

        EmitPulseEvent(state, "content.delta", rawSource, rawMethod, payload, lensEvent =>
        {
            lensEvent.TurnId = turnId;
            lensEvent.ItemId = itemId;
            lensEvent.ContentDelta = new LensPulseContentDeltaPayload
            {
                StreamKind = streamKind,
                Delta = delta
            };
        });
    }

    private void EmitPulsePlanDelta(
        LensRuntimeState state,
        string? turnId,
        string delta,
        string rawSource,
        string rawMethod,
        JsonElement payload)
    {
        EmitPulseEvent(state, "plan.delta", rawSource, rawMethod, payload, lensEvent =>
        {
            lensEvent.TurnId = turnId;
            lensEvent.PlanDelta = new LensPulsePlanDeltaPayload
            {
                Delta = delta
            };
        });
    }

    private void EmitPulsePlanCompleted(
        LensRuntimeState state,
        string? turnId,
        string planMarkdown,
        string rawSource,
        string rawMethod,
        JsonElement payload)
    {
        EmitPulseEvent(state, "plan.completed", rawSource, rawMethod, payload, lensEvent =>
        {
            lensEvent.TurnId = turnId;
            lensEvent.PlanCompleted = new LensPulsePlanCompletedPayload
            {
                PlanMarkdown = planMarkdown
            };
        });
    }

    private void EmitPulseDiffUpdated(
        LensRuntimeState state,
        string? turnId,
        string unifiedDiff,
        string rawSource,
        string rawMethod,
        JsonElement payload)
    {
        EmitPulseEvent(state, "diff.updated", rawSource, rawMethod, payload, lensEvent =>
        {
            lensEvent.TurnId = turnId;
            lensEvent.DiffUpdated = new LensPulseDiffUpdatedPayload
            {
                UnifiedDiff = unifiedDiff
            };
        });
    }

    private void EmitPulseItem(
        LensRuntimeState state,
        string eventType,
        string? turnId,
        string? itemId,
        string itemType,
        string status,
        string? title,
        string? detail,
        IReadOnlyList<LensAttachmentReference>? attachments,
        string rawSource,
        string rawMethod,
        JsonElement payload)
    {
        EmitPulseEvent(state, eventType, rawSource, rawMethod, payload, lensEvent =>
        {
            lensEvent.TurnId = turnId;
            lensEvent.ItemId = itemId;
            lensEvent.Item = new LensPulseItemPayload
            {
                ItemType = itemType,
                Status = status,
                Title = title,
                Detail = detail,
                Attachments = CloneAttachments(attachments)
            };
        });
    }

    private void EmitSubmittedUserTurn(
        LensRuntimeState state,
        string? turnId,
        LensTurnRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Text) && request.Attachments.Count == 0)
        {
            return;
        }

        EmitPulseItem(
            state,
            "item.completed",
            turnId,
            $"local-user:{turnId ?? Guid.NewGuid().ToString("N")}",
            "user_message",
            "completed",
            "User message",
            request.Text,
            request.Attachments,
            "midterm.lens",
            "turn/start",
            default);
    }

    private void EmitPulseRequestOpened(
        LensRuntimeState state,
        string requestId,
        string requestType,
        string requestTypeLabel,
        string? detail,
        string rawSource,
        string rawMethod,
        JsonElement payload)
    {
        EmitPulseEvent(state, "request.opened", rawSource, rawMethod, payload, lensEvent =>
        {
            lensEvent.RequestId = requestId;
            lensEvent.RequestOpened = new LensPulseRequestOpenedPayload
            {
                RequestType = requestType,
                RequestTypeLabel = requestTypeLabel,
                Detail = detail
            };
        });
    }

    private void EmitPulseRequestResolved(
        LensRuntimeState state,
        string requestId,
        string requestType,
        string decision,
        string? turnId = null,
        string? itemId = null)
    {
        EmitPulseEvent(state, "request.resolved", "midterm.lens", "item/requestApproval/decision", default, lensEvent =>
        {
            lensEvent.TurnId = turnId;
            lensEvent.ItemId = itemId;
            lensEvent.RequestId = requestId;
            lensEvent.RequestResolved = new LensPulseRequestResolvedPayload
            {
                RequestType = requestType,
                Decision = decision
            };
        });
    }

    private void EmitPulseUserInputRequested(
        LensRuntimeState state,
        string requestId,
        List<LensPulseQuestion> questions,
        string rawSource,
        string rawMethod,
        JsonElement payload)
    {
        EmitPulseEvent(state, "user-input.requested", rawSource, rawMethod, payload, lensEvent =>
        {
            lensEvent.RequestId = requestId;
            lensEvent.UserInputRequested = new LensPulseUserInputRequestedPayload
            {
                Questions = questions
            };
        });
    }

    private void EmitPulseUserInputResolved(
        LensRuntimeState state,
        string requestId,
        string? turnId,
        string? itemId,
        IReadOnlyDictionary<string, CodexQuestionAnswer> answers)
    {
        EmitPulseEvent(state, "user-input.resolved", "midterm.lens", "item/tool/requestUserInput/answered", default, lensEvent =>
        {
            lensEvent.TurnId = turnId;
            lensEvent.ItemId = itemId;
            lensEvent.RequestId = requestId;
            lensEvent.UserInputResolved = new LensPulseUserInputResolvedPayload
            {
                Answers = answers.Select(pair => new LensPulseAnsweredQuestion
                {
                    QuestionId = pair.Key,
                    Answers = [.. pair.Value.Answers]
                }).ToList()
            };
        });
    }

    private void EmitPulseRuntimeMessage(
        LensRuntimeState state,
        string eventType,
        string message,
        string? detail,
        string rawSource = "midterm.lens",
        string? rawMethod = null,
        JsonElement payload = default)
    {
        EmitPulseEvent(state, eventType, rawSource, rawMethod, payload, lensEvent =>
        {
            lensEvent.RuntimeMessage = new LensPulseRuntimeMessagePayload
            {
                Message = message,
                Detail = detail
            };
        });
    }

    private void EmitPulseEvent(
        LensRuntimeState state,
        string eventType,
        string rawSource,
        string? rawMethod,
        JsonElement payload,
        Action<LensPulseEvent> configure)
    {
        var lensEvent = new LensPulseEvent
        {
            EventId = "lens-" + Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture),
            SessionId = state.SessionId,
            Provider = state.Profile ?? AiCliProfileService.UnknownProfile,
            ThreadId = state.Codex?.ProviderThreadId ?? state.SessionId,
            CreatedAt = DateTimeOffset.UtcNow,
            Type = eventType,
            Raw = new LensPulseEventRaw
            {
                Source = rawSource,
                Method = rawMethod,
                PayloadJson = payload.ValueKind == JsonValueKind.Undefined ? null : payload.GetRawText()
            }
        };

        configure(lensEvent);
        if (string.IsNullOrWhiteSpace(lensEvent.ThreadId))
        {
            lensEvent.ThreadId = state.SessionId;
        }

        _pulse.Append(lensEvent);
    }

    private LensQuickSettingsSummary CreateCodexQuickSettings(LensTurnRequest request)
    {
        var defaultPermissionMode = GetCodexDefaultPermissionMode();
        return LensQuickSettings.CreateSummary(
            request.Model,
            request.Effort,
            request.PlanMode,
            request.PermissionMode,
            defaultPermissionMode);
    }

    private LensQuickSettingsSummary CreateClaudeQuickSettings(LensTurnRequest request)
    {
        var defaultPermissionMode = GetClaudeDefaultPermissionMode();
        return LensQuickSettings.CreateSummary(
            request.Model,
            request.Effort,
            request.PlanMode,
            request.PermissionMode,
            defaultPermissionMode);
    }

    private string GetCodexDefaultPermissionMode()
    {
        return _settingsService?.Load().CodexYoloDefault == true
            ? LensQuickSettings.PermissionModeAuto
            : LensQuickSettings.PermissionModeManual;
    }

    private string GetClaudeDefaultPermissionMode()
    {
        return _settingsService?.Load().ClaudeDangerouslySkipPermissionsDefault == true
            ? LensQuickSettings.PermissionModeAuto
            : LensQuickSettings.PermissionModeManual;
    }

    private static LensQuickSettingsSummary CloneQuickSettingsSummary(LensQuickSettingsSummary quickSettings)
    {
        return new LensQuickSettingsSummary
        {
            Model = LensQuickSettings.NormalizeOptionalValue(quickSettings.Model),
            Effort = LensQuickSettings.NormalizeOptionalValue(quickSettings.Effort),
            PlanMode = LensQuickSettings.NormalizePlanMode(quickSettings.PlanMode),
            PermissionMode = LensQuickSettings.NormalizePermissionMode(quickSettings.PermissionMode)
        };
    }

    private static string ResolveCodexApprovalPolicy(string permissionMode)
    {
        return string.Equals(
            LensQuickSettings.NormalizePermissionMode(permissionMode),
            LensQuickSettings.PermissionModeAuto,
            StringComparison.Ordinal)
            ? "never"
            : "on-request";
    }

    private static string ResolveCodexSandbox(string permissionMode)
    {
        return string.Equals(
            LensQuickSettings.NormalizePermissionMode(permissionMode),
            LensQuickSettings.PermissionModeAuto,
            StringComparison.Ordinal)
            ? "danger-full-access"
            : "workspace-write";
    }

    private static string HumanizeTurnState(string turnState)
    {
        return turnState switch
        {
            "failed" => "Failed",
            "cancelled" => "Cancelled",
            "interrupted" => "Interrupted",
            _ => "Completed"
        };
    }

    private static string HumanizeRequestType(string requestType)
    {
        return requestType switch
        {
            "command_execution_approval" => "Command approval",
            "file_read_approval" => "File read approval",
            "file_change_approval" => "File change approval",
            "tool_user_input" => "User input",
            _ => requestType
        };
    }

    private static List<LensPulseQuestion> ReadCodexQuestions(JsonElement payload)
    {
        var questions = new List<LensPulseQuestion>();
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("questions", out var questionArray) ||
            questionArray.ValueKind != JsonValueKind.Array)
        {
            return questions;
        }

        for (var questionIndex = 0; questionIndex < questionArray.GetArrayLength(); questionIndex++)
        {
            var question = questionArray[questionIndex];
            var item = new LensPulseQuestion
            {
                Id = GetString(question, "id") ?? string.Empty,
                Header = GetString(question, "header") ?? string.Empty,
                Question = GetString(question, "question") ?? string.Empty,
                MultiSelect = GetBoolean(question, "multiSelect")
            };

            if (question.TryGetProperty("options", out var options) && options.ValueKind == JsonValueKind.Array)
            {
                for (var optionIndex = 0; optionIndex < options.GetArrayLength(); optionIndex++)
                {
                    var option = options[optionIndex];
                    item.Options.Add(new LensPulseQuestionOption
                    {
                        Label = GetString(option, "label") ?? string.Empty,
                        Description = GetString(option, "description") ?? string.Empty
                    });
                }
            }

            questions.Add(item);
        }

        return questions;
    }

    private static string? GetString(JsonElement element, params string[] path)
    {
        var current = Traverse(element, path);
        return current is { ValueKind: JsonValueKind.String } value
            ? value.GetString()
            : null;
    }

    private static bool GetBoolean(JsonElement element, params string[] path)
    {
        var current = Traverse(element, path);
        return current is { ValueKind: JsonValueKind.True } || current is { ValueKind: JsonValueKind.False } value && value.GetBoolean();
    }

    private static long? GetLong(JsonElement element, params string[] path)
    {
        var current = Traverse(element, path);
        if (current is not JsonElement value)
        {
            return null;
        }

        return value.ValueKind switch
        {
            JsonValueKind.Number when value.TryGetInt64(out var number) => number,
            JsonValueKind.String when long.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) => parsed,
            _ => null
        };
    }

    private static JsonElement? GetObject(JsonElement element, params string[] path)
    {
        var current = Traverse(element, path);
        return current is { ValueKind: JsonValueKind.Object } value ? value : null;
    }

    private static JsonElement? Traverse(JsonElement element, params string[] path)
    {
        var current = element;
        foreach (var segment in path)
        {
            if (current.ValueKind != JsonValueKind.Object ||
                !current.TryGetProperty(segment, out current))
            {
                return null;
            }
        }

        return current;
    }

    private static async Task DisposeCodexAsync(LensRuntimeState state)
    {
        if (state.Codex is null)
        {
            return;
        }

        var codex = state.Codex;
        state.Codex = null;

        try
        {
            codex.Cancellation.Cancel();
        }
        catch
        {
        }

        try
        {
            if (codex.Process is { HasExited: false } process)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
        }

        if (codex.ReaderTask is not null)
        {
            await Task.WhenAny(codex.ReaderTask, Task.Delay(500, codex.Cancellation.Token)).ConfigureAwait(false);
        }

        codex.Dispose();
    }

    private static void DisposeClaude(LensRuntimeState state)
    {
        if (state.Claude is null)
        {
            return;
        }

        var claude = state.Claude;
        state.Claude = null;

        try
        {
            claude.KillActiveProcess();
        }
        catch
        {
        }

        claude.Dispose();
    }

    private static Process CreateStartedLensProcess(
        string fileName,
        string arguments,
        string workingDirectory,
        string? preferredUserProfileDirectory)
    {
        var process = new Process
        {
            StartInfo = CreateProcessStartInfo(
                fileName,
                arguments,
                workingDirectory,
                preferredUserProfileDirectory),
            EnableRaisingEvents = true
        };

        try
        {
            if (!process.Start())
            {
                throw new InvalidOperationException("Process.Start returned false.");
            }

            return process;
        }
        catch
        {
            process.Dispose();
            throw;
        }
    }

    private static Process CreateStartedLensProcess(
        string fileName,
        IReadOnlyList<string> arguments,
        string workingDirectory,
        string? preferredUserProfileDirectory)
    {
        var process = new Process
        {
            StartInfo = CreateProcessStartInfo(
                fileName,
                arguments,
                workingDirectory,
                preferredUserProfileDirectory),
            EnableRaisingEvents = true
        };

        try
        {
            if (!process.Start())
            {
                throw new InvalidOperationException("Process.Start returned false.");
            }

            return process;
        }
        catch
        {
            process.Dispose();
            throw;
        }
    }

    private sealed class LensRuntimeState
    {
        public LensRuntimeState(string sessionId)
        {
            SessionId = sessionId;
        }

        public string SessionId { get; }
        public Lock SyncRoot { get; } = new();
        public SemaphoreSlim Gate { get; } = new(1, 1);
        public string? Profile { get; set; }
        public string? WorkingDirectory { get; set; }
        public string TransportKey { get; set; } = string.Empty;
        public string TransportLabel { get; set; } = string.Empty;
        public LensRuntimeStatus Status { get; set; }
        public string? LastError { get; set; }
        public DateTimeOffset? LastEventAt { get; set; }
        public string? AssistantText { get; set; }
        public string? UnifiedDiff { get; set; }
        public string? PendingUserInputQuestion { get; set; }
        public LensQuickSettingsSummary QuickSettings { get; set; } = new();
        public long NextSequence { get; set; }
        public List<AgentSessionVibeActivity> Activities { get; } = [];
        public CodexLensRuntime? Codex { get; set; }
        public ClaudeLensRuntime? Claude { get; set; }
    }

    private sealed class CodexLensRuntime : IDisposable
    {
        private CodexLensRuntime(Process process, string permissionMode)
        {
            _transport = OwnedProcessTransport.Create(process);
            PermissionMode = permissionMode;
        }

        public static CodexLensRuntime CreateOwned(Process process, string permissionMode)
        {
            return new CodexLensRuntime(process, permissionMode);
        }

        public static CodexLensRuntime StartOwned(
            string fileName,
            string arguments,
            string workingDirectory,
            string? preferredUserProfileDirectory,
            string permissionMode)
        {
            return new CodexLensRuntime(
                CreateStartedLensProcess(fileName, arguments, workingDirectory, preferredUserProfileDirectory),
                permissionMode);
        }

        private OwnedProcessTransport? _transport;
        public CancellationTokenSource Cancellation { get; } = new();
        public Process? Process => _transport?.Process;
        public StreamReader? Output => _transport?.Output;
        public StreamReader? Error => _transport?.Error;
        public StreamWriter? Input => _transport?.Input;
        public Task? ReaderTask { get; set; }
        public Task? ErrorTask { get; set; }
        public string? ProviderThreadId { get; set; }
        public string? ActiveTurnId { get; set; }
        public string PermissionMode { get; set; } = LensQuickSettings.PermissionModeManual;
        public int NextRequestId;
        public ConcurrentDictionary<string, TaskCompletionSource<JsonRpcReply>> PendingRequests { get; } = new(StringComparer.Ordinal);
        public ConcurrentDictionary<string, PendingCodexApproval> PendingApprovals { get; } = new(StringComparer.Ordinal);
        public ConcurrentDictionary<string, PendingCodexUserInput> PendingUserInputs { get; } = new(StringComparer.Ordinal);
        public bool IsConnected => !string.IsNullOrWhiteSpace(ProviderThreadId);

        public void Dispose()
        {
            Cancellation.Dispose();
            _transport?.Dispose();
            _transport = null;
        }
    }

    private sealed class ClaudeLensRuntime : IDisposable
    {
        private OwnedProcessTransport? _transport;

        private ClaudeLensRuntime(Process activeProcess, string? resumeSessionId)
        {
            _transport = OwnedProcessTransport.Create(activeProcess);
            ResumeSessionId = resumeSessionId;
        }

        public static ClaudeLensRuntime CreateOwned(Process activeProcess, string? resumeSessionId)
        {
            return new ClaudeLensRuntime(activeProcess, resumeSessionId);
        }

        public static ClaudeLensRuntime StartOwned(
            string fileName,
            IReadOnlyList<string> arguments,
            string workingDirectory,
            string? preferredUserProfileDirectory,
            string? resumeSessionId)
        {
            return new ClaudeLensRuntime(
                CreateStartedLensProcess(fileName, arguments, workingDirectory, preferredUserProfileDirectory),
                resumeSessionId);
        }

        public Process? ActiveProcess => _transport?.Process;
        public StreamReader? Output => _transport?.Output;
        public StreamReader? Error => _transport?.Error;
        public StreamWriter? Input => _transport?.Input;
        public Task? ReaderTask { get; set; }
        public Task? ErrorTask { get; set; }
        public string? ResumeSessionId { get; set; }

        public void KillActiveProcess()
        {
            if (ActiveProcess is { HasExited: false } process)
            {
                process.Kill(entireProcessTree: true);
            }
        }

        public void DisposeExitedProcess()
        {
            _transport?.DisposeProcessOnly();
        }

        public void Dispose()
        {
            _transport?.Dispose();
            _transport = null;
        }
    }

    private sealed class OwnedProcessTransport : IDisposable
    {
        private Process? _process;
        private StreamReader? _output;
        private StreamReader? _error;
        private StreamWriter? _input;
        private bool _processDisposed;
        private bool _disposed;

        private OwnedProcessTransport()
        {
        }

        public static OwnedProcessTransport Create(Process process)
        {
            return new OwnedProcessTransport
            {
                _process = process,
                _output = process.StandardOutput,
                _error = process.StandardError,
                _input = process.StandardInput
            };
        }

        public Process? Process => _processDisposed ? null : _process;
        public StreamReader? Output => _disposed ? null : _output;
        public StreamReader? Error => _disposed ? null : _error;
        public StreamWriter? Input => _disposed ? null : _input;

        public void DisposeProcessOnly()
        {
            if (_processDisposed)
            {
                return;
            }

            var process = _process;
            _process = null;
            _processDisposed = true;
            process?.Dispose();
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            var output = _output;
            var error = _error;
            var input = _input;
            _output = null;
            _error = null;
            _input = null;
            output?.Dispose();
            error?.Dispose();
            input?.Dispose();
            DisposeProcessOnly();
        }
    }

    private sealed class PendingCodexUserInput
    {
        public string RequestId { get; set; } = string.Empty;
        public string JsonRpcId { get; set; } = string.Empty;
        public string? TurnId { get; set; }
        public string? ItemId { get; set; }
        public List<string> QuestionIds { get; set; } = [];
        public string Summary { get; set; } = string.Empty;
        public DateTimeOffset CreatedAt { get; set; }
    }

    private sealed class PendingCodexApproval
    {
        public string RequestId { get; set; } = string.Empty;
        public string JsonRpcId { get; set; } = string.Empty;
        public string RequestType { get; set; } = string.Empty;
        public string RequestTypeLabel { get; set; } = string.Empty;
        public string? TurnId { get; set; }
        public string? ItemId { get; set; }
        public string? Detail { get; set; }
    }

    private sealed class JsonRpcReply
    {
        public bool IsError { get; set; }
        public string? ErrorMessage { get; set; }
        public JsonElement Payload { get; set; }
    }

    private sealed class CodexTurnInputEntry
    {
        public string Type { get; set; } = string.Empty;
        public string? Text { get; set; }
        public string? Url { get; set; }
    }

    private sealed class CodexQuestionAnswer
    {
        public List<string> Answers { get; set; } = [];
    }

    private enum LensRuntimeStatus
    {
        None,
        Starting,
        Ready,
        Running,
        Error,
        Stopped
    }
}

public sealed class LensRuntimeSnapshot
{
    public string SessionId { get; init; } = string.Empty;
    public string Profile { get; init; } = string.Empty;
    public string TransportKey { get; init; } = string.Empty;
    public string TransportLabel { get; init; } = string.Empty;
    public string Status { get; init; } = string.Empty;
    public string StatusLabel { get; init; } = string.Empty;
    public string? LastError { get; init; }
    public DateTimeOffset? LastEventAt { get; init; }
    public string? AssistantText { get; init; }
    public string? UnifiedDiff { get; init; }
    public string? PendingQuestion { get; init; }
    public List<AgentSessionVibeActivity> Activities { get; init; } = [];
}
