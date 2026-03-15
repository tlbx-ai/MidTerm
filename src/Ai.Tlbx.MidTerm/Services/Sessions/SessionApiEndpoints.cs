using System.Runtime.InteropServices;
using System.Text;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Common.Shells;

using Ai.Tlbx.MidTerm.Models.Auth;
using Ai.Tlbx.MidTerm.Models.Certificates;
using Ai.Tlbx.MidTerm.Models.Files;
using Ai.Tlbx.MidTerm.Models.History;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Models.System;
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
        WebPreviewService webPreviewService)
    {
        app.MapGet("/api/state", () =>
        {
            var response = new StateUpdate
            {
                Sessions = sessionManager.GetSessionList(),
                Update = updateService.LatestUpdate
            };
            return Results.Json(response, AppJsonContext.Default.StateUpdate);
        });

        app.MapGet("/api/sessions", () =>
        {
            return Results.Json(sessionManager.GetSessionList(), AppJsonContext.Default.SessionListDto);
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

            return Results.Json(GetSessionDto(sessionManager, sessionInfo.Id), AppJsonContext.Default.SessionInfoDto);
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

            var response = new SessionStateResponse
            {
                Session = GetSessionDto(sessionManager, id),
                Previews = webPreviewService.ListPreviewSessions(id).Previews
                    .ToArray()
            };

            if (includeBuffer)
            {
                var buffer = await sessionManager.GetBufferAsync(id);
                if (buffer is not null)
                {
                    response.BufferByteLength = buffer.Length;
                    response.BufferText = Encoding.UTF8.GetString(buffer);
                    response.BufferBase64 = includeBufferBase64
                        ? Convert.ToBase64String(buffer)
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

            await sessionManager.SendInputAsync(id, data);
            return Results.Ok();
        });

        app.MapGet("/api/sessions/{id}/buffer/text", async (string id, bool includeBase64 = false) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            var buffer = await sessionManager.GetBufferAsync(id);
            if (buffer is null)
            {
                return Results.NotFound();
            }

            var response = new SessionBufferTextResponse
            {
                SessionId = id,
                ByteLength = buffer.Length,
                Text = Encoding.UTF8.GetString(buffer),
                Base64 = includeBase64 ? Convert.ToBase64String(buffer) : null
            };

            return Results.Json(response, AppJsonContext.Default.SessionBufferTextResponse);
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

            return Results.Json(GetSessionDto(sessionManager, id), AppJsonContext.Default.SessionInfoDto);
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

            if (IsImageUpload(file, targetPath))
            {
                var preferredProcessId = session.HostPid > 0 ? session.HostPid : session.Pid;
                await clipboardService.SetImageAsync(targetPath, file.ContentType, preferredProcessId);
            }

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

            var preferredProcessId = session.HostPid > 0 ? session.HostPid : session.Pid;
            var success = await clipboardService.SetImageAsync(targetPath, file.ContentType, preferredProcessId);
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
            var (claudeUpdated, agentsUpdated) = MidtermDirectory.AppendRootPointer(cwd);

            return Results.Json(new InjectGuidanceResponse
            {
                MidtermDir = midtermDir,
                ClaudeMdUpdated = claudeUpdated,
                AgentsMdUpdated = agentsUpdated,
            }, AppJsonContext.Default.InjectGuidanceResponse);
        });
    }

    private static bool TryGetInputBytes(
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
                text += "\n";
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
                data[^1] = (byte)'\n';
            }
            return true;
        }
        catch (FormatException)
        {
            error = "base64 is invalid.";
            return false;
        }
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

    private static bool IsImageUpload(IFormFile file, string savedPath)
    {
        if (!string.IsNullOrWhiteSpace(file.ContentType) &&
            file.ContentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var extension = Path.GetExtension(savedPath);
        return !string.IsNullOrWhiteSpace(extension) && ClipboardImageExtensions.Contains(extension);
    }

    private static SessionInfoDto GetSessionDto(TtyHostSessionManager sessionManager, string sessionId)
    {
        return sessionManager.GetSessionList().Sessions.First(s => s.Id == sessionId);
    }
}
