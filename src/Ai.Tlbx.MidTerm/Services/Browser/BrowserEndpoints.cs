using System.Text;
using Ai.Tlbx.MidTerm.Models.Browser;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Ai.Tlbx.MidTerm.Services.Tmux;
using Ai.Tlbx.MidTerm.Services.WebPreview;

namespace Ai.Tlbx.MidTerm.Services.Browser;

public static class BrowserEndpoints
{
    public static void MapBrowserEndpoints(
        WebApplication app,
        BrowserCommandService commandService,
        BrowserPreviewRegistry previewRegistry,
        BrowserPreviewOriginService previewOriginService,
        TtyHostSessionManager sessionManager,
        WebPreviewService webPreviewService,
        BrowserUiBridge? uiBridge = null)
    {
        MapPreviewClientEndpoint(app, previewRegistry, previewOriginService, webPreviewService);
        MapStatusEndpoint(app, commandService, webPreviewService, uiBridge);
        MapCliEndpoint(app, commandService, sessionManager, webPreviewService, uiBridge);
        MapJsonEndpoints(app, commandService, sessionManager, webPreviewService);

        if (uiBridge is not null)
        {
            MapUiEndpoints(app, commandService, uiBridge, webPreviewService);
        }
    }

    private static void MapStatusEndpoint(
        WebApplication app,
        BrowserCommandService commandService,
        WebPreviewService webPreviewService,
        BrowserUiBridge? uiBridge)
    {
        app.MapGet("/api/browser/status", (string? sessionId, string? previewName, string? previewId) =>
        {
            var targetUrl = !string.IsNullOrWhiteSpace(sessionId)
                ? webPreviewService.GetTargetUrl(sessionId, previewName)
                : null;
            var status = commandService.GetStatus(
                targetUrl,
                sessionId,
                previewName,
                previewId,
                uiBridge?.ConnectedBrowserCount ?? 0);
            return Results.Json(status, AppJsonContext.Default.BrowserStatusResponse);
        });

        app.MapGet("/api/browser/status-text", (string? sessionId, string? previewName, string? previewId) =>
        {
            var targetUrl = !string.IsNullOrWhiteSpace(sessionId)
                ? webPreviewService.GetTargetUrl(sessionId, previewName)
                : null;
            var status = commandService.GetStatusText(
                targetUrl,
                sessionId,
                previewName,
                previewId,
                uiBridge?.ConnectedBrowserCount ?? 0);
            return Results.Text(status);
        });
    }

    private static void MapPreviewClientEndpoint(
        WebApplication app,
        BrowserPreviewRegistry previewRegistry,
        BrowserPreviewOriginService previewOriginService,
        WebPreviewService webPreviewService)
    {
        app.MapPost("/api/browser/preview-client", (BrowserPreviewClientRequest request, HttpContext ctx) =>
        {
            if (string.IsNullOrWhiteSpace(request.SessionId))
            {
                return Results.BadRequest("sessionId required");
            }

            var preview = webPreviewService.EnsurePreviewSession(request.SessionId, request.PreviewName);
            var created = previewRegistry.Create(
                preview.SessionId,
                preview.PreviewName,
                preview.RouteKey,
                ctx.Request.Cookies["mt-client-id"]);
            var response = new BrowserPreviewClientResponse
            {
                SessionId = created.SessionId,
                PreviewName = created.PreviewName,
                RouteKey = created.RouteKey,
                PreviewId = created.PreviewId,
                PreviewToken = created.PreviewToken,
                Origin = previewOriginService.GetOrigin(ctx.Request)
            };
            return Results.Json(response, AppJsonContext.Default.BrowserPreviewClientResponse);
        });
    }

    private static void MapUiEndpoints(
        WebApplication app,
        BrowserCommandService commandService,
        BrowserUiBridge uiBridge,
        WebPreviewService webPreviewService)
    {
        app.MapPost("/api/browser/detach", (Models.WebPreview.WebPreviewSessionRequest request) =>
        {
            return uiBridge.RequestDetach(
                NormalizeOptional(request.SessionId),
                NormalizeOptional(request.PreviewName),
                out var error)
                ? Results.Ok()
                : Results.Text(error + "\n", statusCode: 409);
        });

        app.MapPost("/api/browser/dock", (Models.WebPreview.WebPreviewSessionRequest request) =>
        {
            return uiBridge.RequestDock(
                NormalizeOptional(request.SessionId),
                NormalizeOptional(request.PreviewName),
                out var error)
                ? Results.Ok()
                : Results.Text(error + "\n", statusCode: 409);
        });

        app.MapPost("/api/browser/viewport", (Models.Browser.ViewportRequest request) =>
        {
            return uiBridge.RequestViewport(
                NormalizeOptional(request.SessionId),
                NormalizeOptional(request.PreviewName),
                request.Width,
                request.Height,
                out var error)
                ? Results.Ok()
                : Results.Text(error + "\n", statusCode: 409);
        });

        app.MapPost("/api/browser/open", async (Models.WebPreview.WebPreviewTargetRequest request, CancellationToken cancellationToken) =>
        {
            var sessionId = NormalizeOptional(request.SessionId);
            var previewName = NormalizeOptional(request.PreviewName);
            var url = request.Url ?? "";
            var activateSession = request.ActivateSession ?? true;
            if (string.IsNullOrWhiteSpace(sessionId))
            {
                return Results.BadRequest("sessionId required");
            }

            if (!webPreviewService.SetTarget(sessionId, previewName, url))
            {
                return Results.BadRequest("Invalid URL. Must be http://, https://, or a local file:/// URL, and cannot point to this server.");
            }

            if (!uiBridge.RequestOpen(
                sessionId,
                previewName,
                url,
                activateSession,
                out var error))
            {
                return Results.Text(error + "\n", statusCode: 409);
            }

            var status = await commandService.WaitForControllableAsync(
                url,
                sessionId,
                previewName,
                requireClientConnectedAfterUtc: DateTimeOffset.UtcNow,
                connectedUiClientCountProvider: () => uiBridge.ConnectedBrowserCount,
                cancellationToken: cancellationToken);

            var statusText = commandService.GetStatusText(
                url,
                sessionId,
                previewName,
                connectedUiClientCount: uiBridge.ConnectedBrowserCount);

            return status.Controllable
                ? Results.Text(statusText)
                : Results.Text(statusText, statusCode: 409);
        });
    }

    private static void MapCliEndpoint(
        WebApplication app,
        BrowserCommandService commandService,
        TtyHostSessionManager sessionManager,
        WebPreviewService webPreviewService,
        BrowserUiBridge? uiBridge)
    {
        app.MapPost("/api/browser", async (HttpContext ctx) =>
        {
            using var ms = new MemoryStream();
            await ctx.Request.Body.CopyToAsync(ms);
            var body = ms.ToArray();

            var args = TmuxCommandParser.ParseNullDelimitedArgs(body);
            if (args.Count == 0)
            {
                BrowserLog.Error($"Empty request ({body.Length} bytes)");
                return Results.Text("usage: mtbrowser <command> [args...]\n\nCommands:\n  query <selector> [--depth N] [--text]\n  click <selector>\n  fill <selector> <value>\n  exec <js-code>\n  screenshot [--session <id>]\n  snapshot --session <id>\n  wait <selector> [--timeout N]\n  navigate <url>\n  reload [--hard]\n  outline [depth]     Page structure (tag+id+class tree)\n  attrs <selector>    Element attributes (no children)\n  css <selector> <props>  Computed CSS (comma-separated)\n  log [error|warn|all]    Console log buffer\n  links               All links on page\n  submit [selector]   Submit form (default: first form)\n  forms [selector]    Form structure and values\n  url                 Current upstream page URL\n  clearcookies        Clear browser-side cookies in iframe\n  status\n", statusCode: 400);
            }

            var command = args[0].ToLowerInvariant();

            if (command == "status")
            {
                var sessionId = GetFlagValue(args, "--session");
                var previewName = GetFlagValue(args, "--preview");
                var previewId = GetFlagValue(args, "--preview-id");
                var targetUrl = sessionId is not null
                    ? webPreviewService.GetTargetUrl(sessionId, previewName)
                    : null;
                var status = commandService.GetStatusText(
                    targetUrl,
                    sessionId,
                    previewName,
                    previewId,
                    uiBridge?.ConnectedBrowserCount ?? 0).TrimEnd('\n', '\r');
                return Results.Text(status);
            }

            var request = ParseCliArgs(command, args);
            if (request is null)
            {
                return Results.Text($"unknown command: {command}\n", statusCode: 400);
            }

            var result = await commandService.ExecuteCommandAsync(request, ctx.RequestAborted);

            if (command is "snapshot" or "screenshot" && result.Success && result.Result is not null)
            {
                var saved = await SaveResultToDiskAsync(command, result, request, sessionManager, webPreviewService);
                if (saved is not null)
                {
                    return Results.Text(saved + "\n");
                }
            }

            if (!result.Success)
            {
                return Results.Text(result.Error ?? "command failed\n", statusCode: 400);
            }

            var output = result.Result ?? "";
            if (!output.EndsWith('\n'))
                output += "\n";
            return Results.Text(output);
        });
    }

    private static void MapJsonEndpoints(
        WebApplication app,
        BrowserCommandService commandService,
        TtyHostSessionManager sessionManager,
        WebPreviewService webPreviewService)
    {
        app.MapPost("/api/browser/command", async (BrowserCommandRequest request, HttpContext ctx) =>
        {
            if (string.IsNullOrWhiteSpace(request.Command))
            {
                return Results.BadRequest("command required");
            }

            var result = await commandService.ExecuteCommandAsync(request, ctx.RequestAborted);
            return ToJsonResult(result);
        });

        app.MapPost("/api/browser/query", async (BrowserCommandRequest request, HttpContext ctx) =>
        {
            var cmd = WithCommand(request, "query");
            var result = await commandService.ExecuteCommandAsync(cmd, ctx.RequestAborted);
            return ToJsonResult(result);
        });

        app.MapPost("/api/browser/click", async (BrowserCommandRequest request, HttpContext ctx) =>
        {
            var cmd = WithCommand(request, "click");
            var result = await commandService.ExecuteCommandAsync(cmd, ctx.RequestAborted);
            return ToJsonResult(result);
        });

        app.MapPost("/api/browser/fill", async (BrowserCommandRequest request, HttpContext ctx) =>
        {
            var cmd = WithCommand(request, "fill");
            var result = await commandService.ExecuteCommandAsync(cmd, ctx.RequestAborted);
            return ToJsonResult(result);
        });

        app.MapPost("/api/browser/exec", async (BrowserCommandRequest request, HttpContext ctx) =>
        {
            var cmd = WithCommand(request, "exec");
            var result = await commandService.ExecuteCommandAsync(cmd, ctx.RequestAborted);
            return ToJsonResult(result);
        });

        app.MapPost("/api/browser/wait", async (BrowserCommandRequest request, HttpContext ctx) =>
        {
            var cmd = WithCommand(request, "wait");
            var result = await commandService.ExecuteCommandAsync(cmd, ctx.RequestAborted);
            return ToJsonResult(result);
        });

        app.MapPost("/api/browser/screenshot", async (BrowserCommandRequest request, HttpContext ctx) =>
        {
            var cmd = WithCommand(request, "screenshot");
            var result = await commandService.ExecuteCommandAsync(cmd, ctx.RequestAborted);

            if (result.Success && result.Result is not null)
            {
                var path = await SaveResultToDiskAsync("screenshot", result, cmd, sessionManager, webPreviewService);
                if (path is not null)
                {
                    return ToJsonResult(new BrowserWsResult
                    {
                        Id = result.Id,
                        Success = true,
                        Result = path
                    });
                }
            }

            return ToJsonResult(result);
        });

        app.MapPost("/api/browser/screenshot-raw", async (BrowserCommandRequest request, HttpContext ctx) =>
        {
            var cmd = WithCommand(request, "screenshot");
            var result = await commandService.ExecuteCommandAsync(cmd, ctx.RequestAborted);
            return ToJsonResult(result);
        });

        app.MapPost("/api/browser/snapshot", async (BrowserCommandRequest request, HttpContext ctx) =>
        {
            var cmd = WithCommand(request, "snapshot");
            var result = await commandService.ExecuteCommandAsync(cmd, ctx.RequestAborted);

            if (result.Success && result.Result is not null)
            {
                var path = await SaveResultToDiskAsync("snapshot", result, cmd, sessionManager, webPreviewService);
                if (path is not null)
                {
                    return ToJsonResult(new BrowserWsResult
                    {
                        Id = result.Id,
                        Success = true,
                        Result = path
                    });
                }
            }

            return ToJsonResult(result);
        });

        app.MapPost("/api/browser/outline", async (BrowserCommandRequest request, HttpContext ctx) =>
        {
            var cmd = WithCommand(request, "outline");
            var result = await commandService.ExecuteCommandAsync(cmd, ctx.RequestAborted);
            return ToJsonResult(result);
        });

        app.MapPost("/api/browser/attrs", async (BrowserCommandRequest request, HttpContext ctx) =>
        {
            var cmd = WithCommand(request, "attrs");
            var result = await commandService.ExecuteCommandAsync(cmd, ctx.RequestAborted);
            return ToJsonResult(result);
        });

        app.MapPost("/api/browser/css", async (BrowserCommandRequest request, HttpContext ctx) =>
        {
            var cmd = WithCommand(request, "css");
            var result = await commandService.ExecuteCommandAsync(cmd, ctx.RequestAborted);
            return ToJsonResult(result);
        });

        app.MapPost("/api/browser/log", async (BrowserCommandRequest request, HttpContext ctx) =>
        {
            var cmd = WithCommand(request, "log");
            var result = await commandService.ExecuteCommandAsync(cmd, ctx.RequestAborted);
            return ToJsonResult(result);
        });

        app.MapPost("/api/browser/links", async (BrowserCommandRequest request, HttpContext ctx) =>
        {
            var cmd = WithCommand(request, "links");
            var result = await commandService.ExecuteCommandAsync(cmd, ctx.RequestAborted);
            return ToJsonResult(result);
        });

        app.MapPost("/api/browser/submit", async (BrowserCommandRequest request, HttpContext ctx) =>
        {
            var cmd = WithCommand(request, "submit");
            var result = await commandService.ExecuteCommandAsync(cmd, ctx.RequestAborted);
            return ToJsonResult(result);
        });

        app.MapPost("/api/browser/forms", async (BrowserCommandRequest request, HttpContext ctx) =>
        {
            var cmd = WithCommand(request, "forms");
            var result = await commandService.ExecuteCommandAsync(cmd, ctx.RequestAborted);
            return ToJsonResult(result);
        });
    }

    private static BrowserCommandRequest? ParseCliArgs(string command, List<string> args)
    {
        var request = command switch
        {
            "query" => new BrowserCommandRequest
            {
                Command = "query",
                Selector = GetPositional(args, 1),
                MaxDepth = GetIntFlag(args, "--depth"),
                TextOnly = HasFlag(args, "--text"),
                Timeout = GetIntFlag(args, "--timeout")
            },
            "click" => new BrowserCommandRequest
            {
                Command = "click",
                Selector = GetPositional(args, 1)
            },
            "fill" => new BrowserCommandRequest
            {
                Command = "fill",
                Selector = GetPositional(args, 1),
                Value = GetPositional(args, 2)
            },
            "exec" => new BrowserCommandRequest
            {
                Command = "exec",
                Value = GetPositional(args, 1),
                Timeout = GetIntFlag(args, "--timeout")
            },
            "screenshot" => new BrowserCommandRequest
            {
                Command = "screenshot",
                SessionId = GetFlagValue(args, "--session")
            },
            "snapshot" => new BrowserCommandRequest
            {
                Command = "snapshot",
                SessionId = GetFlagValue(args, "--session")
            },
            "wait" => new BrowserCommandRequest
            {
                Command = "wait",
                Selector = GetPositional(args, 1),
                Timeout = GetIntFlag(args, "--timeout") ?? 5
            },
            "navigate" => new BrowserCommandRequest
            {
                Command = "navigate",
                Value = GetPositional(args, 1)
            },
            "reload" => new BrowserCommandRequest
            {
                Command = "reload",
                Value = HasFlag(args, "--hard") ? "hard" : "soft"
            },
            "outline" => new BrowserCommandRequest
            {
                Command = "outline",
                MaxDepth = GetIntFlag(args, "--depth") ??
                    (args.Count > 1 && int.TryParse(args[1], out var od) ? od : 4)
            },
            "attrs" => new BrowserCommandRequest
            {
                Command = "attrs",
                Selector = GetPositional(args, 1)
            },
            "css" => new BrowserCommandRequest
            {
                Command = "css",
                Selector = GetPositional(args, 1),
                Value = GetPositional(args, 2)
            },
            "log" => new BrowserCommandRequest
            {
                Command = "log",
                Value = GetPositional(args, 1) ?? "all"
            },
            "links" => new BrowserCommandRequest
            {
                Command = "links"
            },
            "submit" => new BrowserCommandRequest
            {
                Command = "submit",
                Selector = GetPositional(args, 1)
            },
            "forms" => new BrowserCommandRequest
            {
                Command = "forms",
                Selector = GetPositional(args, 1)
            },
            "url" => new BrowserCommandRequest { Command = "url" },
            "clearcookies" => new BrowserCommandRequest { Command = "clearcookies" },
            _ => null
        };

        return request is null
            ? null
            : new BrowserCommandRequest
            {
                Command = request.Command,
                Selector = request.Selector,
                Value = request.Value,
                MaxDepth = request.MaxDepth,
                TextOnly = request.TextOnly,
                Timeout = request.Timeout,
                SessionId = GetFlagValue(args, "--session"),
                PreviewName = GetFlagValue(args, "--preview"),
                PreviewId = request.PreviewId
            };
    }

    private static async Task<string?> SaveResultToDiskAsync(
        string command,
        BrowserWsResult result,
        BrowserCommandRequest request,
        TtyHostSessionManager sessionManager,
        WebPreviewService webPreviewService)
    {
        string? cwd = null;
        if (request.SessionId is not null)
        {
            var session = sessionManager.GetSession(request.SessionId);
            cwd = session?.CurrentDirectory;
        }

        if (string.IsNullOrEmpty(cwd))
        {
            var sessions = sessionManager.GetAllSessions();
            cwd = sessions.FirstOrDefault(s => !string.IsNullOrEmpty(s.CurrentDirectory))?.CurrentDirectory;
        }

        if (string.IsNullOrEmpty(cwd) || !Directory.Exists(cwd))
            return null;

        if (command == "screenshot" && result.Result is not null)
        {
            var screenshotsDir = MidtermDirectory.EnsureSubdirectory(cwd, "screenshots");

            var ts = DateTime.Now.ToString("yyyyMMdd_HHmmss");
            var filePath = Path.Combine(screenshotsDir, $"screenshot_{ts}.png");

            try
            {
                var base64 = result.Result;
                if (base64.Contains(','))
                    base64 = base64[(base64.IndexOf(',') + 1)..];

                var bytes = Convert.FromBase64String(base64);
                await File.WriteAllBytesAsync(filePath, bytes);
                return filePath;
            }
            catch (Exception ex)
            {
                BrowserLog.Error($"Failed to save screenshot: {ex.Message}");
                return null;
            }
        }

        if (command == "snapshot" && result.Result is not null)
        {
            var ts = DateTime.Now.ToString("yyyyMMdd_HHmmss");
            var snapshotDir = MidtermDirectory.EnsureSubdirectory(cwd, $"snapshot_{ts}");

            try
            {
                var html = result.Result;
                await File.WriteAllTextAsync(Path.Combine(snapshotDir, "index.html"), html);

                return snapshotDir;
            }
            catch (Exception ex)
            {
                BrowserLog.Error($"Failed to save snapshot: {ex.Message}");
                return null;
            }
        }

        return null;
    }

    private static BrowserCommandRequest WithCommand(BrowserCommandRequest request, string command) =>
        new()
        {
            Command = command,
            Selector = request.Selector,
            Value = request.Value,
            MaxDepth = request.MaxDepth,
            TextOnly = request.TextOnly,
            Timeout = request.Timeout,
            SessionId = request.SessionId,
            PreviewName = request.PreviewName,
            PreviewId = request.PreviewId
        };

    private static IResult ToJsonResult(BrowserWsResult result)
    {
        var response = new BrowserCommandResponse
        {
            Success = result.Success,
            Result = result.Result,
            Error = result.Error,
            MatchCount = result.MatchCount
        };
        return Results.Json(response, AppJsonContext.Default.BrowserCommandResponse);
    }

    private static string? GetPositional(List<string> args, int index)
    {
        for (int i = 1, pos = 0; i < args.Count; i++)
        {
            if (args[i].StartsWith("--"))
            {
                i++;
                continue;
            }
            if (pos == index - 1)
                return args[i];
            pos++;
        }
        return null;
    }

    private static string? GetFlagValue(List<string> args, string flag)
    {
        for (var i = 1; i < args.Count - 1; i++)
        {
            if (args[i].Equals(flag, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        }
        return null;
    }

    private static int? GetIntFlag(List<string> args, string flag)
    {
        var value = GetFlagValue(args, flag);
        return value is not null && int.TryParse(value, out var n) ? n : null;
    }

    private static bool HasFlag(List<string> args, string flag)
    {
        return args.Any(a => a.Equals(flag, StringComparison.OrdinalIgnoreCase));
    }

    private static string? NormalizeOptional(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }
}
