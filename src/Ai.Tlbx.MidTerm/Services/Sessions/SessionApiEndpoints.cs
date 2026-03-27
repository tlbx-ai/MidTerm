using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Common.Shells;

using Ai.Tlbx.MidTerm.Models.Auth;
using Ai.Tlbx.MidTerm.Models.Certificates;
using Ai.Tlbx.MidTerm.Models.Files;
using Ai.Tlbx.MidTerm.Models.History;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Models.System;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Services.Tmux;
using Ai.Tlbx.MidTerm.Services.Updates;
using Ai.Tlbx.MidTerm.Services.WebPreview;
namespace Ai.Tlbx.MidTerm.Services.Sessions;

public static partial class SessionApiEndpoints
{
    private static readonly HashSet<string> ClipboardImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".bmp",
        ".webp",
        ".tif",
        ".tiff"
    };

    [LibraryImport("kernel32.dll", EntryPoint = "GetShortPathNameW", StringMarshalling = StringMarshalling.Utf16)]
    private static partial uint GetShortPathName(string lpszLongPath, char[] lpszShortPath, uint cchBuffer);

    private static string ToShortPath(string path)
    {
        if (!OperatingSystem.IsWindows())
        {
            return path;
        }

        var buffer = new char[260];
        var length = GetShortPathName(path, buffer, (uint)buffer.Length);
        return length > 0 ? new string(buffer, 0, (int)length) : path;
    }

    public static void MapSessionEndpoints(
        WebApplication app,
        TtyHostSessionManager sessionManager,
        ClipboardService clipboardService,
        UpdateService updateService,
        WebPreviewService webPreviewService,
        SessionTelemetryService sessionTelemetry,
        SessionAgentFeedService agentFeed,
        SessionSupervisorService sessionSupervisor,
        SessionLensPulseService lensPulse,
        SessionLensRuntimeService lensRuntime,
        SessionCodexHandoffService codexHandoff,
        SessionAgentVibeService agentVibe,
        AiCliProfileService aiCliProfileService,
        WorkerSessionRegistryService workerSessionRegistry)
    {
        app.MapGet("/api/state", () =>
        {
            var response = new StateUpdate
            {
                Sessions = GetSessionListDto(sessionManager, sessionSupervisor, lensPulse),
                Update = updateService.LatestUpdate
            };
            return Results.Json(response, AppJsonContext.Default.StateUpdate);
        });

        app.MapGet("/api/sessions", () =>
        {
            return Results.Json(GetSessionListDto(sessionManager, sessionSupervisor, lensPulse), AppJsonContext.Default.SessionListDto);
        });

        app.MapGet("/api/sessions/attention", (bool agentOnly = true) =>
        {
            var response = sessionSupervisor.DescribeFleet(GetSessionListDto(sessionManager, sessionSupervisor, lensPulse).Sessions, agentOnly);
            return Results.Json(response, AppJsonContext.Default.SessionAttentionResponse);
        });

        app.MapPost("/api/sessions", async (CreateSessionRequest? request) =>
        {
            var cols = request?.Cols ?? 120;
            var rows = request?.Rows ?? 30;

            ShellType? shellType = null;
            if (!string.IsNullOrEmpty(request?.Shell) && Enum.TryParse<ShellType>(request.Shell, true, out var parsed))
            {
                shellType = parsed;
            }

            var sessionInfo = await sessionManager.CreateSessionAsync(
                shellType?.ToString(), cols, rows, request?.WorkingDirectory);

            if (sessionInfo is null)
            {
                return Results.Problem("Failed to create session");
            }

            return Results.Json(GetSessionDto(sessionManager, sessionSupervisor, lensPulse, sessionInfo.Id), AppJsonContext.Default.SessionInfoDto);
        });

        app.MapPost("/api/workers/bootstrap", async (WorkerBootstrapRequest request, CancellationToken ct) =>
        {
            var sessionInfo = await sessionManager.CreateSessionAsync(
                request.Shell, request.Cols, request.Rows, request.WorkingDirectory, ct);

            if (sessionInfo is null)
            {
                return Results.Problem("Failed to create worker session");
            }

            var sessionId = sessionInfo.Id;

            if (request.AgentControlled)
            {
                sessionManager.SetAgentControlled(sessionId, true);
            }

            var requestedProfile = aiCliProfileService.NormalizeProfile(request.Profile);
            if (requestedProfile != AiCliProfileService.UnknownProfile)
            {
                sessionManager.SetProfileHint(sessionId, requestedProfile);
            }

            if (request.LensOnly)
            {
                sessionManager.SetLensOnly(sessionId, true);
            }

            if (!string.IsNullOrWhiteSpace(request.Name))
            {
                await sessionManager.SetSessionNameAsync(sessionId, request.Name, isManual: true, ct);
            }

            var workerSession = GetSessionDto(sessionManager, sessionSupervisor, lensPulse, sessionId);
            var resolvedProfile = aiCliProfileService.NormalizeProfile(request.Profile, workerSession);
            var launchCommand = request.LensOnly
                ? null
                : string.IsNullOrWhiteSpace(request.LaunchCommand)
                    ? aiCliProfileService.GetDefaultLaunchCommand(resolvedProfile)
                    : request.LaunchCommand.Trim();

            var guidanceInjected = false;
            string? midtermDir = null;
            var targetDirectory = workerSession.CurrentDirectory ?? request.WorkingDirectory;
            if (request.InjectGuidance &&
                !string.IsNullOrWhiteSpace(targetDirectory) &&
                Directory.Exists(targetDirectory))
            {
                midtermDir = MidtermDirectory.TryEnsureForCwd(targetDirectory);
                guidanceInjected = midtermDir is not null;
            }

            if (!string.IsNullOrWhiteSpace(launchCommand))
            {
                await SendInputAndRecordAsync(sessionManager, sessionTelemetry, sessionId, Encoding.UTF8.GetBytes(launchCommand + "\r"), ct);
                if (request.LaunchDelayMs > 0)
                {
                    await Task.Delay(request.LaunchDelayMs, ct);
                }
            }

            var slashCommands = request.LensOnly
                ? []
                : aiCliProfileService.NormalizeSlashCommands(resolvedProfile, request.SlashCommands);
            workerSessionRegistry.Register(
                sessionId,
                resolvedProfile,
                launchCommand,
                slashCommands,
                request.LaunchDelayMs,
                request.SlashCommandDelayMs);
            agentFeed.NoteWorkerBootstrap(
                sessionId,
                resolvedProfile,
                launchCommand,
                slashCommands,
                guidanceInjected);
            foreach (var slashCommand in slashCommands)
            {
                var currentSession = GetSessionDto(sessionManager, sessionSupervisor, lensPulse, sessionId);
                if (!TryBuildPromptExecutionPlan(
                        new SessionPromptRequest
                        {
                            Text = slashCommand,
                            Mode = "auto",
                            Profile = resolvedProfile,
                            SubmitDelayMs = request.SlashCommandDelayMs
                        },
                        currentSession,
                        aiCliProfileService,
                        out var plan,
                        out var error))
                {
                    return Results.BadRequest(error);
                }

                await ExecutePromptPlanAsync(sessionManager, sessionTelemetry, sessionId, plan, ct);
            }

            return Results.Json(new WorkerBootstrapResponse
            {
                Session = GetSessionDto(sessionManager, sessionSupervisor, lensPulse, sessionId),
                Profile = resolvedProfile,
                LaunchCommand = launchCommand,
                SlashCommands = slashCommands,
                GuidanceInjected = guidanceInjected,
                MidtermDir = midtermDir
            }, AppJsonContext.Default.WorkerBootstrapResponse);
        });

        app.MapPost("/api/sessions/reorder", (SessionReorderRequest request) =>
        {
            if (request.SessionIds.Count == 0)
            {
                return Results.BadRequest("sessionIds required");
            }

            return sessionManager.ReorderSessions(request.SessionIds)
                ? Results.Ok()
                : Results.BadRequest("Invalid session IDs");
        });

        app.MapDelete("/api/sessions/{id}", async (string id) =>
        {
            workerSessionRegistry.Forget(id);
            agentFeed.Forget(id);
            await sessionManager.CloseSessionAsync(id);
            return Results.Ok();
        });

        app.MapPost("/api/sessions/{id}/resize", async (string id, ResizeRequest request) =>
        {
            var success = await sessionManager.ResizeSessionAsync(id, request.Cols, request.Rows);
            if (!success)
            {
                return Results.NotFound();
            }
            return Results.Json(new ResizeResponse
            {
                Accepted = true,
                Cols = request.Cols,
                Rows = request.Rows
            }, AppJsonContext.Default.ResizeResponse);
        });

        app.MapGet("/api/sessions/{id}/state", async (string id, bool includeBuffer = true, bool includeBufferBase64 = false) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            await sessionManager.GetSessionFreshAsync(id).ConfigureAwait(false);

            var response = new SessionStateResponse
            {
                Session = GetSessionDto(sessionManager, sessionSupervisor, lensPulse, id),
                Previews = webPreviewService.ListPreviewSessions(id).Previews.ToArray(),
                TerminalTransport = BuildTerminalTransportDiagnostics(sessionManager, id)
            };

            if (includeBuffer)
            {
                var snapshot = await sessionManager.GetBufferAsync(id);
                if (snapshot is not null)
                {
                    response.BufferByteLength = snapshot.Data.Length;
                    response.BufferText = Encoding.UTF8.GetString(snapshot.Data);
                    response.BufferBase64 = includeBufferBase64
                        ? Convert.ToBase64String(snapshot.Data)
                        : null;
                }
            }

            return Results.Json(response, AppJsonContext.Default.SessionStateResponse);
        });

        app.MapPost("/api/sessions/{id}/input/text", async (string id, SessionInputRequest request) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            if (!TryGetInputBytes(request, out var data, out var error))
            {
                return Results.BadRequest(error);
            }

            await SendInputAndRecordAsync(sessionManager, sessionTelemetry, id, data);
            return Results.Ok();
        });

        app.MapPost("/api/sessions/{id}/input/keys", async (string id, SessionKeyInputRequest request) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            if (!TryGetKeyInputBytes(request, out var data, out var error))
            {
                return Results.BadRequest(error);
            }

            await SendInputAndRecordAsync(sessionManager, sessionTelemetry, id, data);
            agentFeed.NoteKeyInput(id, request);
            return Results.Ok();
        });

        app.MapPost("/api/sessions/{id}/input/prompt", async (string id, SessionPromptRequest request, CancellationToken ct) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            var session = await EnsureWorkerReadyForPromptAsync(
                sessionManager,
                sessionTelemetry,
                sessionSupervisor,
                lensPulse,
                aiCliProfileService,
                workerSessionRegistry,
                id,
                request,
                ct);

            if (await lensRuntime.TrySendPromptAsync(id, request, ct).ConfigureAwait(false))
            {
                var promptProfile = aiCliProfileService.NormalizeProfile(request.Profile, session);
                agentFeed.NotePrompt(id, promptProfile, request);
                return Results.Ok();
            }

            if (!TryBuildPromptExecutionPlan(
                    request,
                    session,
                    aiCliProfileService,
                    out var plan,
                    out var error))
            {
                return Results.BadRequest(error);
            }

            await ExecutePromptPlanAsync(sessionManager, sessionTelemetry, id, plan, ct);
            var resolvedProfile = aiCliProfileService.NormalizeProfile(request.Profile, session);
            agentFeed.NotePrompt(id, resolvedProfile, request);
            return Results.Ok();
        });

        app.MapPost("/api/sessions/{id}/lens/attach", async (string id, CancellationToken ct) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            var session = GetSessionDto(sessionManager, sessionSupervisor, lensPulse, id);
            string? resumeThreadId = null;
            if (!session.LensOnly &&
                aiCliProfileService.NormalizeProfile(null, session) == AiCliProfileService.CodexProfile)
            {
                try
                {
                    resumeThreadId = await codexHandoff.PrepareForLensAsync(session, ct).ConfigureAwait(false);
                }
                catch (InvalidOperationException ex)
                {
                    return Results.BadRequest(ex.Message);
                }
            }

            try
            {
                var attached = await lensRuntime.EnsureAttachedAsync(id, session, resumeThreadId, ct).ConfigureAwait(false);
                return attached ? Results.Ok() : Results.BadRequest("Lens native runtime is not available for this session.");
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"Lens attach failed for {id}: {ex.Message}");
                return Results.Problem(title: "Lens attach failed", detail: ex.Message, statusCode: StatusCodes.Status503ServiceUnavailable);
            }
        });

        app.MapPost("/api/sessions/{id}/lens/detach", async (string id, CancellationToken ct) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            var session = GetSessionDto(sessionManager, sessionSupervisor, lensPulse, id);
            if (session.LensOnly ||
                aiCliProfileService.NormalizeProfile(null, session) != AiCliProfileService.CodexProfile)
            {
                await lensRuntime.DetachAsync(id, ct).ConfigureAwait(false);
                return Results.Ok();
            }

            try
            {
                await codexHandoff.RestoreTerminalAsync(session, ct).ConfigureAwait(false);
                return Results.Ok();
            }
            catch (InvalidOperationException ex)
            {
                return Results.BadRequest(ex.Message);
            }
        });

        app.MapPost("/api/sessions/{id}/lens/turns", async (string id, LensTurnRequest request, CancellationToken ct) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            var session = GetSessionDto(sessionManager, sessionSupervisor, lensPulse, id);
            if (!await lensRuntime.EnsureAttachedAsync(id, session, ct: ct).ConfigureAwait(false))
            {
                return Results.BadRequest("Lens native runtime is not available for this session.");
            }

            try
            {
                var response = await lensRuntime.StartTurnAsync(id, request, ct).ConfigureAwait(false);
                return Results.Json(response, AppJsonContext.Default.LensTurnStartResponse);
            }
            catch (InvalidOperationException ex)
            {
                return Results.BadRequest(ex.Message);
            }
        });

        app.MapPost("/api/sessions/{id}/lens/interrupt", async (string id, LensInterruptRequest request, CancellationToken ct) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            try
            {
                var response = await lensRuntime.InterruptTurnAsync(id, request, ct).ConfigureAwait(false);
                return Results.Json(response, AppJsonContext.Default.LensCommandAcceptedResponse);
            }
            catch (InvalidOperationException ex)
            {
                return Results.BadRequest(ex.Message);
            }
        });

        app.MapPost("/api/sessions/{id}/lens/requests/{requestId}/approve", async (string id, string requestId, CancellationToken ct) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            try
            {
                var response = await lensRuntime.ResolveRequestAsync(id, requestId, new LensRequestDecisionRequest
                {
                    Decision = "accept"
                }, ct).ConfigureAwait(false);
                return Results.Json(response, AppJsonContext.Default.LensCommandAcceptedResponse);
            }
            catch (InvalidOperationException ex)
            {
                return Results.BadRequest(ex.Message);
            }
        });

        app.MapPost("/api/sessions/{id}/lens/requests/{requestId}/resolve", async (string id, string requestId, LensRequestDecisionRequest request, CancellationToken ct) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            try
            {
                var response = await lensRuntime.ResolveRequestAsync(id, requestId, request, ct).ConfigureAwait(false);
                return Results.Json(response, AppJsonContext.Default.LensCommandAcceptedResponse);
            }
            catch (InvalidOperationException ex)
            {
                return Results.BadRequest(ex.Message);
            }
        });

        app.MapPost("/api/sessions/{id}/lens/requests/{requestId}/decline", async (string id, string requestId, LensRequestDecisionRequest request, CancellationToken ct) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            request.Decision = string.IsNullOrWhiteSpace(request.Decision) ? "decline" : request.Decision;
            try
            {
                var response = await lensRuntime.ResolveRequestAsync(id, requestId, request, ct).ConfigureAwait(false);
                return Results.Json(response, AppJsonContext.Default.LensCommandAcceptedResponse);
            }
            catch (InvalidOperationException ex)
            {
                return Results.BadRequest(ex.Message);
            }
        });

        app.MapPost("/api/sessions/{id}/lens/user-input/{requestId}", async (string id, string requestId, LensUserInputAnswerRequest request, CancellationToken ct) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            try
            {
                var response = await lensRuntime.ResolveUserInputAsync(id, requestId, request, ct).ConfigureAwait(false);
                return Results.Json(response, AppJsonContext.Default.LensCommandAcceptedResponse);
            }
            catch (InvalidOperationException ex)
            {
                return Results.BadRequest(ex.Message);
            }
        });

        app.MapGet("/api/sessions/{id}/lens/snapshot", (string id) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            var snapshot = lensPulse.GetSnapshot(id);
            return snapshot is null
                ? Results.NotFound()
                : Results.Json(snapshot, AppJsonContext.Default.LensPulseSnapshotResponse);
        });

        app.MapGet("/api/sessions/{id}/lens/events", (string id, long afterSequence = 0) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            var events = lensPulse.GetEvents(id, afterSequence);
            return Results.Json(events, AppJsonContext.Default.LensPulseEventListResponse);
        });

        app.MapGet("/api/sessions/{id}/lens/events/stream", async (string id, HttpContext httpContext, long afterSequence = 0) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                httpContext.Response.StatusCode = StatusCodes.Status404NotFound;
                return;
            }

            if (httpContext.Request.Headers.TryGetValue("Last-Event-ID", out var lastEventIdValues) &&
                long.TryParse(lastEventIdValues.ToString(), out var lastEventId) &&
                lastEventId > afterSequence)
            {
                afterSequence = lastEventId;
            }

            httpContext.Response.StatusCode = StatusCodes.Status200OK;
            httpContext.Response.ContentType = "text/event-stream";
            httpContext.Response.Headers["Cache-Control"] = "no-cache";
            httpContext.Response.Headers["X-Accel-Buffering"] = "no";
            await httpContext.Response.StartAsync(httpContext.RequestAborted).ConfigureAwait(false);

            using var keepAliveTimer = new PeriodicTimer(TimeSpan.FromSeconds(15));
            using var subscription = lensPulse.Subscribe(id, afterSequence, httpContext.RequestAborted);
            var reader = subscription.Reader;

            while (!httpContext.RequestAborted.IsCancellationRequested)
            {
                while (reader.TryRead(out var lensEvent))
                {
                    await WriteLensStreamEventAsync(httpContext, lensEvent, httpContext.RequestAborted).ConfigureAwait(false);
                }

                var readTask = reader.WaitToReadAsync(httpContext.RequestAborted).AsTask();
                var keepAliveTask = keepAliveTimer.WaitForNextTickAsync(httpContext.RequestAborted).AsTask();
                var completedTask = await Task.WhenAny(readTask, keepAliveTask).ConfigureAwait(false);
                if (completedTask == keepAliveTask)
                {
                    if (!await keepAliveTask.ConfigureAwait(false))
                    {
                        break;
                    }

                    await httpContext.Response.WriteAsync(": keep-alive\n\n", httpContext.RequestAborted).ConfigureAwait(false);
                    await httpContext.Response.Body.FlushAsync(httpContext.RequestAborted).ConfigureAwait(false);
                    continue;
                }

                if (!await readTask.ConfigureAwait(false))
                {
                    break;
                }
            }
        });

        app.MapGet("/api/sessions/{id}/buffer/text", async (string id, bool includeBase64 = false) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            var snapshot = await sessionManager.GetBufferAsync(id);
            if (snapshot is null)
            {
                return Results.NotFound();
            }

            var response = new SessionBufferTextResponse
            {
                SessionId = id,
                ByteLength = snapshot.Data.Length,
                Text = Encoding.UTF8.GetString(snapshot.Data),
                Base64 = includeBase64 ? Convert.ToBase64String(snapshot.Data) : null
            };

            return Results.Json(response, AppJsonContext.Default.SessionBufferTextResponse);
        });

        app.MapGet("/api/sessions/{id}/buffer/tail", async (string id, int lines = 120, bool stripAnsi = true) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            var snapshot = await sessionManager.GetBufferAsync(id);
            if (snapshot is null)
            {
                return Results.NotFound();
            }

            var text = TerminalOutputSanitizer.Decode(snapshot.Data);
            if (stripAnsi)
            {
                text = TerminalOutputSanitizer.StripEscapeSequences(text);
            }

            text = TerminalOutputSanitizer.TailLines(text, lines, out _, out _);
            return Results.Text(text, "text/plain", Encoding.UTF8);
        });

        app.MapGet("/api/sessions/{id}/activity", (string id, int seconds = 120, int bellLimit = 25) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            var response = sessionTelemetry.GetActivity(id, seconds, bellLimit);
            return Results.Json(response, AppJsonContext.Default.SessionActivityResponse);
        });

        app.MapGet("/api/sessions/{id}/agent", async (
            string id,
            int tailLines = 80,
            int activitySeconds = 90,
            int bellLimit = 8,
            CancellationToken ct = default) =>
        {
            var response = await agentVibe.BuildVibeAsync(id, tailLines, activitySeconds, bellLimit, ct);
            return response is null
                ? Results.NotFound()
                : Results.Json(response, AppJsonContext.Default.AgentSessionVibeResponse);
        });

        app.MapGet("/api/sessions/{id}/agent/feed", async (
            string id,
            int tailLines = 80,
            int activitySeconds = 90,
            int bellLimit = 8,
            CancellationToken ct = default) =>
        {
            var vibe = await agentVibe.BuildVibeAsync(id, tailLines, activitySeconds, bellLimit, ct);
            if (vibe is null)
            {
                return Results.NotFound();
            }

            var feed = agentFeed.GetFeed(id, vibe.Source, vibe.Activities, vibe.GeneratedAt);
            return Results.Json(feed, AppJsonContext.Default.AgentSessionFeedResponse);
        });

        app.MapPut("/api/sessions/{id}/name", async (string id, RenameSessionRequest request, bool auto = false) =>
        {
            if (!await sessionManager.SetSessionNameAsync(id, request.Name, isManual: !auto))
            {
                return Results.NotFound();
            }
            return Results.Ok();
        });

        app.MapPut("/api/sessions/{id}/bookmark", (string id, SetBookmarkRequest request) =>
        {
            if (!sessionManager.SetBookmarkId(id, request.BookmarkId))
            {
                return Results.NotFound();
            }
            return Results.Ok();
        });

        app.MapPut("/api/sessions/{id}/control", (string id, SetSessionControlRequest request) =>
        {
            if (!sessionManager.SetAgentControlled(id, request.AgentControlled))
            {
                return Results.NotFound();
            }

            return Results.Json(GetSessionDto(sessionManager, sessionSupervisor, lensPulse, id), AppJsonContext.Default.SessionInfoDto);
        });

        app.MapPost("/api/sessions/{id}/upload", async (string id, IFormFile file) =>
        {
            var session = sessionManager.GetSession(id);
            if (session is null)
            {
                return Results.NotFound();
            }

            if (file is null || file.Length == 0)
            {
                return Results.BadRequest("No file provided");
            }

            var targetPath = await SaveUploadedFileAsync(sessionManager, id, file);

            // To make Johannes happy
            if (!File.Exists(targetPath))
            {
                return Results.Problem("File write succeeded but file not found");
            }

            // Use 8.3 short path on Windows for compatibility with legacy apps
            var responsePath = ToShortPath(targetPath);

            return Results.Json(new FileUploadResponse { Path = responsePath }, AppJsonContext.Default.FileUploadResponse);
        }).DisableAntiforgery();

        app.MapPost("/api/sessions/{id}/paste-clipboard-image", async (string id, IFormFile file) =>
        {
            var session = sessionManager.GetSession(id);
            if (session is null)
            {
                return Results.NotFound();
            }

            if (file is null || file.Length == 0)
            {
                return Results.BadRequest("No file provided");
            }

            var targetPath = await SaveUploadedFileAsync(sessionManager, id, file);

            var success = await TrySetClipboardImageAsync(
                sessionManager,
                clipboardService,
                session,
                id,
                targetPath,
                file.ContentType);
            if (!success)
            {
                return Results.Problem("Failed to set clipboard");
            }

            await sessionManager.SendInputAsync(id, new byte[] { 0x1b, 0x76 });

            return Results.Ok();
        }).DisableAntiforgery();

        app.MapPost("/api/sessions/{id}/inject-guidance", (string id) =>
        {
            var session = sessionManager.GetSession(id);
            if (session is null)
            {
                return Results.NotFound();
            }

            var cwd = session.CurrentDirectory;
            if (string.IsNullOrWhiteSpace(cwd) || !Directory.Exists(cwd))
            {
                return Results.BadRequest("Session has no valid working directory");
            }

            var midtermDir = MidtermDirectory.Ensure(cwd);

            return Results.Json(new InjectGuidanceResponse
            {
                MidtermDir = midtermDir,
                MtcliShellPath = Path.Combine(midtermDir, "mtcli.sh"),
                MtcliPowerShellPath = Path.Combine(midtermDir, "mtcli.ps1"),
                ClaudeMdUpdated = false,
                AgentsMdUpdated = false,
            }, AppJsonContext.Default.InjectGuidanceResponse);
        });
    }

    private static async Task WriteLensStreamEventAsync(
        HttpContext httpContext,
        LensPulseEvent lensEvent,
        CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.Serialize(lensEvent, AppJsonContext.Default.LensPulseEvent);
        await httpContext.Response.WriteAsync($"id: {lensEvent.Sequence}\n", cancellationToken).ConfigureAwait(false);
        await httpContext.Response.WriteAsync("event: lens\n", cancellationToken).ConfigureAwait(false);
        await httpContext.Response.WriteAsync($"data: {payload}\n\n", cancellationToken).ConfigureAwait(false);
        await httpContext.Response.Body.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    internal static bool TryGetInputBytes(
        SessionInputRequest request,
        out byte[] data,
        out string error)
    {
        data = [];
        error = "";

        var hasText = !string.IsNullOrEmpty(request.Text);
        var hasBase64 = !string.IsNullOrEmpty(request.Base64);

        if (hasText == hasBase64)
        {
            error = "Provide exactly one of text or base64.";
            return false;
        }

        if (hasText)
        {
            var text = request.Text!;
            if (request.AppendNewline)
            {
                text += "\r";
            }

            data = Encoding.UTF8.GetBytes(text);
            return true;
        }

        try
        {
            data = Convert.FromBase64String(request.Base64!);
            if (request.AppendNewline)
            {
                Array.Resize(ref data, data.Length + 1);
                data[^1] = (byte)'\r';
            }
            return true;
        }
        catch (FormatException)
        {
            error = "base64 is invalid.";
            return false;
        }
    }

    internal static bool TryGetKeyInputBytes(
        SessionKeyInputRequest request,
        out byte[] data,
        out string error)
    {
        data = [];
        error = "";

        if (request.Keys is null || request.Keys.Count == 0)
        {
            error = "Provide at least one key.";
            return false;
        }

        if (!request.Literal && request.Keys.Any(string.IsNullOrWhiteSpace))
        {
            error = "Keys cannot be empty.";
            return false;
        }

        data = TmuxKeyTranslator.TranslateKeys(request.Keys, request.Literal);
        return true;
    }

    internal static bool TryGetPromptInputSequence(
        SessionPromptRequest request,
        bool interruptFirst,
        out byte[]? interruptData,
        out byte[] promptData,
        out byte[] submitData,
        out int interruptDelayMs,
        out int submitDelayMs,
        out string error)
    {
        interruptData = null;
        promptData = [];
        submitData = [];
        error = "";

        if (request.InterruptDelayMs < 0 || request.SubmitDelayMs < 0 || request.FollowupSubmitDelayMs < 0)
        {
            interruptDelayMs = 0;
            submitDelayMs = 0;
            error = "Delay values cannot be negative.";
            return false;
        }

        interruptDelayMs = request.InterruptDelayMs;
        submitDelayMs = request.SubmitDelayMs;

        if (!TryGetInputBytes(new SessionInputRequest
            {
                Text = request.Text,
                Base64 = request.Base64,
                AppendNewline = false
            },
            out promptData,
            out error))
        {
            return false;
        }

        if (!TryGetKeyInputBytes(new SessionKeyInputRequest
            {
                Keys = request.SubmitKeys,
                Literal = request.LiteralSubmitKeys
            },
            out submitData,
            out error))
        {
            error = error == "Provide at least one key."
                ? "Provide at least one submit key."
                : error;
            return false;
        }

        if (!interruptFirst)
        {
            return true;
        }

        if (!TryGetKeyInputBytes(new SessionKeyInputRequest
            {
                Keys = request.InterruptKeys,
                Literal = request.LiteralInterruptKeys
            },
            out var translatedInterruptData,
            out error))
        {
            error = error == "Provide at least one key."
                ? "Provide at least one interrupt key."
                : error;
            return false;
        }

        interruptData = translatedInterruptData;
        return true;
    }

    internal static bool TryGetPromptInputSequence(
        SessionPromptRequest request,
        out byte[]? interruptData,
        out byte[] promptData,
        out byte[] submitData,
        out int interruptDelayMs,
        out int submitDelayMs,
        out string error)
    {
        return TryGetPromptInputSequence(
            request,
            request.InterruptFirst,
            out interruptData,
            out promptData,
            out submitData,
            out interruptDelayMs,
            out submitDelayMs,
            out error);
    }

    internal static bool TryBuildPromptExecutionPlan(
        SessionPromptRequest request,
        SessionInfoDto session,
        AiCliProfileService aiCliProfileService,
        out SessionPromptExecutionPlan plan,
        out string error)
    {
        plan = new SessionPromptExecutionPlan(null, [], [], 0, 0, 0, 0);
        error = "";

        var mode = NormalizePromptMode(request.Mode);
        if (mode is null)
        {
            error = "Mode must be auto, append, or interrupt-first.";
            return false;
        }

        var supervisor = session.Supervisor ?? new SessionSupervisorInfoDto();
        var profile = aiCliProfileService.NormalizeProfile(request.Profile, session);
        var interruptFirst = mode switch
        {
            "interrupt-first" => true,
            "append" => false,
            _ => supervisor.State == SessionSupervisorService.BusyTurnState
        };

        if (!TryGetPromptInputSequence(
                request,
                interruptFirst,
                out var interruptData,
                out var promptData,
                out var submitData,
                out var interruptDelayMs,
                out var submitDelayMs,
                out error))
        {
            return false;
        }

        var followupSubmitCount = request.FollowupSubmitCount;
        if (followupSubmitCount <= 0 &&
            request.Text?.Contains('\n') == true &&
            aiCliProfileService.IsInteractiveAi(profile))
        {
            followupSubmitCount = 1;
        }

        plan = new SessionPromptExecutionPlan(
            interruptData,
            promptData,
            submitData,
            interruptDelayMs,
            submitDelayMs,
            followupSubmitCount,
            request.FollowupSubmitDelayMs);
        return true;
    }

    private static string? NormalizePromptMode(string? mode)
    {
        return (mode ?? "auto").Trim().ToLowerInvariant() switch
        {
            "auto" => "auto",
            "append" => "append",
            "interrupt-first" or "interruptfirst" => "interrupt-first",
            _ => null
        };
    }

    private static async Task ExecutePromptPlanAsync(
        TtyHostSessionManager sessionManager,
        SessionTelemetryService sessionTelemetry,
        string sessionId,
        SessionPromptExecutionPlan plan,
        CancellationToken ct)
    {
        if (plan.InterruptData is { Length: > 0 })
        {
            await SendInputAndRecordAsync(sessionManager, sessionTelemetry, sessionId, plan.InterruptData, ct);
            if (plan.InterruptDelayMs > 0)
            {
                await Task.Delay(plan.InterruptDelayMs, ct);
            }
        }

        await SendInputAndRecordAsync(sessionManager, sessionTelemetry, sessionId, plan.PromptData, ct);
        if (plan.SubmitDelayMs > 0)
        {
            await Task.Delay(plan.SubmitDelayMs, ct);
        }

        await SendInputAndRecordAsync(sessionManager, sessionTelemetry, sessionId, plan.SubmitData, ct);

        for (var i = 0; i < plan.FollowupSubmitCount; i++)
        {
            if (plan.FollowupSubmitDelayMs > 0)
            {
                await Task.Delay(plan.FollowupSubmitDelayMs, ct);
            }

            await SendInputAndRecordAsync(sessionManager, sessionTelemetry, sessionId, plan.SubmitData, ct);
        }
    }

    private static async Task<SessionInfoDto> EnsureWorkerReadyForPromptAsync(
        TtyHostSessionManager sessionManager,
        SessionTelemetryService sessionTelemetry,
        SessionSupervisorService sessionSupervisor,
        SessionLensPulseService lensPulse,
        AiCliProfileService aiCliProfileService,
        WorkerSessionRegistryService workerSessionRegistry,
        string sessionId,
        SessionPromptRequest request,
        CancellationToken ct)
    {
        var session = GetSessionDto(sessionManager, sessionSupervisor, lensPulse, sessionId);
        if (session.Supervisor?.State != SessionSupervisorService.ShellState)
        {
            return session;
        }

        if (!TryBuildWorkerAutoResumePlan(sessionId, request, session, aiCliProfileService, workerSessionRegistry, out var resumePlan))
        {
            return session;
        }

        await SendInputAndRecordAsync(
            sessionManager,
            sessionTelemetry,
            sessionId,
            Encoding.UTF8.GetBytes(resumePlan.LaunchCommand + "\r"),
            ct);

        if (resumePlan.LaunchDelayMs > 0)
        {
            await Task.Delay(resumePlan.LaunchDelayMs, ct);
        }

        foreach (var slashCommand in resumePlan.SlashCommands)
        {
            var currentSession = GetSessionDto(sessionManager, sessionSupervisor, lensPulse, sessionId);
            if (!TryBuildPromptExecutionPlan(
                    new SessionPromptRequest
                    {
                        Text = slashCommand,
                        Mode = "auto",
                        Profile = resumePlan.Profile,
                        SubmitDelayMs = resumePlan.SlashCommandDelayMs
                    },
                    currentSession,
                    aiCliProfileService,
                    out var slashPlan,
                    out _))
            {
                continue;
            }

            await ExecutePromptPlanAsync(sessionManager, sessionTelemetry, sessionId, slashPlan, ct);
        }

        return GetSessionDto(sessionManager, sessionSupervisor, lensPulse, sessionId);
    }

    internal static bool TryBuildWorkerAutoResumePlan(
        string sessionId,
        SessionPromptRequest request,
        SessionInfoDto session,
        AiCliProfileService aiCliProfileService,
        WorkerSessionRegistryService workerSessionRegistry,
        out WorkerAutoResumePlan plan)
    {
        plan = new WorkerAutoResumePlan(string.Empty, AiCliProfileService.UnknownProfile, [], 0, 0);

        if (session.Supervisor?.State != SessionSupervisorService.ShellState)
        {
            return false;
        }

        if (session.LensOnly)
        {
            return false;
        }

        var hasRegistry = workerSessionRegistry.TryGet(sessionId, out var registration);
        var profile = aiCliProfileService.NormalizeProfile(
            request.Profile ?? (hasRegistry ? registration!.Profile : null),
            session);

        if (!aiCliProfileService.IsInteractiveAi(profile))
        {
            return false;
        }

        var launchCommand = hasRegistry
            ? registration!.LaunchCommand
            : aiCliProfileService.GetDefaultLaunchCommand(profile);

        if (string.IsNullOrWhiteSpace(launchCommand))
        {
            return false;
        }

        plan = new WorkerAutoResumePlan(
            launchCommand.Trim(),
            profile,
            hasRegistry ? registration!.SlashCommands : [],
            hasRegistry ? registration!.LaunchDelayMs : 1200,
            hasRegistry ? registration!.SlashCommandDelayMs : 350);
        return true;
    }

    private static async Task SendInputAndRecordAsync(
        TtyHostSessionManager sessionManager,
        SessionTelemetryService sessionTelemetry,
        string sessionId,
        byte[] data,
        CancellationToken ct = default)
    {
        sessionTelemetry.RecordInput(sessionId, data.Length);
        await sessionManager.SendInputAsync(sessionId, data, ct);
    }

    internal readonly record struct WorkerAutoResumePlan(
        string LaunchCommand,
        string Profile,
        IReadOnlyList<string> SlashCommands,
        int LaunchDelayMs,
        int SlashCommandDelayMs);

    internal static int GetPreferredClipboardProcessId(SessionInfo session)
    {
        return session.HostPid > 0 ? session.HostPid : session.Pid;
    }

    internal static async Task<bool> TrySetClipboardImageAsync(
        Func<CancellationToken, Task<bool>> sessionScopedSetter,
        Func<CancellationToken, Task<bool>> fallbackSetter,
        CancellationToken ct = default)
    {
        if (await sessionScopedSetter(ct).ConfigureAwait(false))
        {
            return true;
        }

        return await fallbackSetter(ct).ConfigureAwait(false);
    }

    private static async Task<string> SaveUploadedFileAsync(
        TtyHostSessionManager sessionManager, string sessionId, IFormFile file)
    {
        var fileName = Path.GetFileName(file.FileName);
        if (string.IsNullOrWhiteSpace(fileName))
        {
            fileName = $"upload_{DateTime.UtcNow:yyyyMMdd_HHmmss}";
        }

        var uploadDir = GetUploadDirectory(sessionManager, sessionId);

        var targetPath = Path.Combine(uploadDir, fileName);
        var counter = 1;
        var baseName = Path.GetFileNameWithoutExtension(fileName);
        var extension = Path.GetExtension(fileName);
        while (File.Exists(targetPath))
        {
            fileName = $"{baseName}_{counter}{extension}";
            targetPath = Path.Combine(uploadDir, fileName);
            counter++;
        }

        await using (var stream = File.Create(targetPath))
        {
            await file.CopyToAsync(stream);
        }

        return targetPath;
    }

    private static Task<bool> TrySetClipboardImageAsync(
        TtyHostSessionManager sessionManager,
        ClipboardService clipboardService,
        SessionInfo session,
        string sessionId,
        string targetPath,
        string? mimeType,
        CancellationToken ct = default)
    {
        var preferredProcessId = GetPreferredClipboardProcessId(session);
        return TrySetClipboardImageAsync(
            token => sessionManager.SetClipboardImageAsync(sessionId, targetPath, mimeType, token),
            _ => clipboardService.SetImageAsync(targetPath, mimeType, preferredProcessId),
            ct);
    }

    private static string GetUploadDirectory(TtyHostSessionManager sessionManager, string sessionId)
    {
        var session = sessionManager.GetSession(sessionId);
        var cwd = session?.CurrentDirectory;

        if (!string.IsNullOrWhiteSpace(cwd) && Directory.Exists(cwd))
        {
            try
            {
                return MidtermDirectory.EnsureSubdirectory(cwd, "uploads");
            }
            catch
            {
                // Fall through to temp directory if cwd is not writable
            }
        }

        return sessionManager.GetTempDirectory(sessionId);
    }

    private static SessionListDto GetSessionListDto(
        TtyHostSessionManager sessionManager,
        SessionSupervisorService sessionSupervisor,
        SessionLensPulseService lensPulse)
    {
        var response = sessionManager.GetSessionList();
        foreach (var session in response.Sessions)
        {
            session.Supervisor = sessionSupervisor.Describe(session);
            session.HasLensHistory = lensPulse.HasHistory(session.Id);
        }

        return response;
    }

    private static TerminalTransportDiagnosticsDto BuildTerminalTransportDiagnostics(
        TtyHostSessionManager sessionManager,
        string sessionId)
    {
        var session = sessionManager.GetSession(sessionId);
        var transport = session?.Transport;
        var runtime = sessionManager.GetTransportRuntimeSnapshot(sessionId);

        return new TerminalTransportDiagnosticsDto
        {
            SourceSeq = ((transport?.SourceSeq ?? 0UL) > 0 ? transport!.SourceSeq : runtime.SourceSeq).ToString(),
            MuxReceivedSeq = runtime.MuxReceivedSeq.ToString(),
            MthostIpcQueuedSeq = (transport?.IpcQueuedSeq ?? 0UL).ToString(),
            MthostIpcFlushedSeq = (transport?.IpcFlushedSeq ?? 0UL).ToString(),
            IpcBacklogFrames = transport?.IpcBacklogFrames ?? 0,
            IpcBacklogBytes = transport?.IpcBacklogBytes ?? 0,
            OldestBacklogAgeMs = transport?.OldestBacklogAgeMs ?? 0,
            ScrollbackBytes = transport?.ScrollbackBytes ?? 0,
            LastReplayBytes = Math.Max(transport?.LastReplayBytes ?? 0, runtime.LastReplayBytes),
            LastReplayReason = (runtime.LastReplayReason ?? transport?.LastReplayReason)?.ToString(),
            ReconnectCount = runtime.ReconnectCount,
            DataLossCount = Math.Max(transport?.DataLossCount ?? 0, runtime.DataLossCount),
            LastDataLossReason = (runtime.LastDataLossReason ?? transport?.LastDataLossReason)?.ToString()
        };
    }

    private static SessionInfoDto GetSessionDto(
        TtyHostSessionManager sessionManager,
        SessionSupervisorService sessionSupervisor,
        SessionLensPulseService lensPulse,
        string sessionId)
    {
        return GetSessionListDto(sessionManager, sessionSupervisor, lensPulse).Sessions.First(s => s.Id == sessionId);
    }

    internal sealed record SessionPromptExecutionPlan(
        byte[]? InterruptData,
        byte[] PromptData,
        byte[] SubmitData,
        int InterruptDelayMs,
        int SubmitDelayMs,
        int FollowupSubmitCount,
        int FollowupSubmitDelayMs);
}
