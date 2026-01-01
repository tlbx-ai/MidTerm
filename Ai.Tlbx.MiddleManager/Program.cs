using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MiddleManager.Models;
using Ai.Tlbx.MiddleManager.Services;
using Ai.Tlbx.MiddleManager.Settings;
using Ai.Tlbx.MiddleManager.Shells;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;

namespace Ai.Tlbx.MiddleManager;

public class Program
{
    private const int DefaultPort = 2000;
    private const string DefaultBindAddress = "0.0.0.0";

    private static void DebugLog(string message) => DebugLogger.Log(message);

    public static async Task Main(string[] args)
    {
        if (HandleSpecialCommands(args))
        {
            return;
        }

        var (port, bindAddress, useConHost) = ParseCommandLineArgs(args);
        var builder = CreateBuilder(args);
        var app = builder.Build();
        var version = GetVersion();

        ConfigureStaticFiles(app);

        var settingsService = app.Services.GetRequiredService<SettingsService>();
        var updateService = app.Services.GetRequiredService<UpdateService>();
        var authService = app.Services.GetRequiredService<AuthService>();

        // Configure debug logging from settings
        var settings = settingsService.Load();

        // Authentication middleware
        ConfigureAuthMiddleware(app, settingsService, authService);
        DebugLogger.Enabled = settings.DebugLogging;
        if (DebugLogger.Enabled)
        {
            DebugLogger.ClearLogs();
            DebugLogger.Log("Debug logging enabled");
        }

        // Con-host mode: mm.exe spawns mm-con-host per session (service mode)
        ConHostSessionManager? conHostSessionManager = null;
        ConHostMuxConnectionManager? conHostMuxManager = null;

        // Direct mode: mm.exe creates PTY directly (standalone mode)
        SessionManager? directSessionManager = null;
        MuxConnectionManager? directMuxManager = null;

        string modeDescription;

        if (useConHost)
        {
            conHostSessionManager = new ConHostSessionManager();
            conHostMuxManager = new ConHostMuxConnectionManager(conHostSessionManager);
            await conHostSessionManager.DiscoverExistingSessionsAsync();
            modeDescription = "Service (sessions persist, one process per terminal)";
        }
        else
        {
            directSessionManager = app.Services.GetRequiredService<SessionManager>();
            directMuxManager = new MuxConnectionManager(directSessionManager);
            directSessionManager.SetMuxManager(directMuxManager);
            modeDescription = "Direct (sessions lost on restart)";
        }

        MapApiEndpoints(app, conHostSessionManager, directSessionManager, updateService, version);
        MapWebSocketMiddleware(app, conHostSessionManager, directSessionManager, conHostMuxManager, directMuxManager, updateService);

        PrintWelcomeBanner(port, bindAddress, settingsService, version, modeDescription);
        RunWithPortErrorHandling(app, port, bindAddress);

        // Cleanup
        if (conHostMuxManager is not null)
        {
            await conHostMuxManager.DisposeAsync();
        }
        if (conHostSessionManager is not null)
        {
            await conHostSessionManager.DisposeAsync();
        }
    }

    private static bool HandleSpecialCommands(string[] args)
    {
        if (args.Contains("--check-update"))
        {
            var updateService = new UpdateService();
            var update = updateService.CheckForUpdateAsync().GetAwaiter().GetResult();
            if (update is not null && update.Available)
            {
                Console.WriteLine($"Update available: {update.CurrentVersion} -> {update.LatestVersion}");
                Console.WriteLine($"Download: {update.ReleaseUrl}");
            }
            else
            {
                Console.WriteLine($"You are running the latest version ({updateService.CurrentVersion})");
            }
            updateService.Dispose();
            return true;
        }

        if (args.Contains("--update"))
        {
            var updateService = new UpdateService();
            Console.WriteLine("Checking for updates...");
            var update = updateService.CheckForUpdateAsync().GetAwaiter().GetResult();

            if (update is null || !update.Available)
            {
                Console.WriteLine($"You are running the latest version ({updateService.CurrentVersion})");
                updateService.Dispose();
                return true;
            }

            Console.WriteLine($"Downloading {update.LatestVersion}...");
            var extractedDir = updateService.DownloadUpdateAsync().GetAwaiter().GetResult();

            if (string.IsNullOrEmpty(extractedDir))
            {
                Console.WriteLine("Failed to download update.");
                updateService.Dispose();
                return true;
            }

            Console.WriteLine("Applying update...");
            var scriptPath = UpdateScriptGenerator.GenerateUpdateScript(extractedDir, UpdateService.GetCurrentBinaryPath());
            UpdateScriptGenerator.ExecuteUpdateScript(scriptPath);
            Console.WriteLine("Update script started. Exiting...");
            updateService.Dispose();
            return true;
        }

        if (args.Contains("--version") || args.Contains("-v"))
        {
            Console.WriteLine(GetVersion());
            return true;
        }

        // --hash-password: Generate password hash for install scripts
        var hashIndex = Array.IndexOf(args, "--hash-password");
        if (hashIndex >= 0 && hashIndex + 1 < args.Length)
        {
            var password = args[hashIndex + 1];
            var authService = new AuthService(new SettingsService());
            Console.WriteLine(authService.HashPassword(password));
            return true;
        }

        return false;
    }

    private static (int port, string bindAddress, bool useConHost) ParseCommandLineArgs(string[] args)
    {
        var port = DefaultPort;
        var bindAddress = DefaultBindAddress;
        // --service: running as Windows service entry point
        // --spawned: spawned by mm-host, also needs con-host mode for proper PTY
        var useConHost = args.Contains("--service") || args.Contains("--spawned");

        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--port" && i + 1 < args.Length && int.TryParse(args[i + 1], out var p))
            {
                port = p;
                i++;
            }
            else if (args[i] == "--bind" && i + 1 < args.Length)
            {
                bindAddress = args[i + 1];
                i++;
            }
        }

        return (port, bindAddress, useConHost);
    }

    private static WebApplicationBuilder CreateBuilder(string[] args)
    {
        var builder = WebApplication.CreateSlimBuilder(args);

#if WINDOWS
        // Enable Windows Service hosting (no-op when not running as service)
        builder.Host.UseWindowsService();
#endif

        builder.WebHost.ConfigureKestrel(options => options.AddServerHeader = false);
        builder.Logging.SetMinimumLevel(LogLevel.Warning);

        builder.Services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
        });

        builder.Services.AddSingleton<ShellRegistry>();
        builder.Services.AddSingleton<SettingsService>();
        builder.Services.AddSingleton<SessionManager>();
        builder.Services.AddSingleton<UpdateService>();
        builder.Services.AddSingleton<AuthService>();

        return builder;
    }

    private static string GetVersion()
    {
        return Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "1.0.0";
    }

    private static void ConfigureStaticFiles(WebApplication app)
    {
#if DEBUG
        var wwwrootPath = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "wwwroot");
        IFileProvider fileProvider = Directory.Exists(wwwrootPath)
            ? new PhysicalFileProvider(Path.GetFullPath(wwwrootPath))
            : new EmbeddedWebRootFileProvider(Assembly.GetExecutingAssembly(), "Ai.Tlbx.MiddleManager");
#else
        IFileProvider fileProvider = new EmbeddedWebRootFileProvider(
            Assembly.GetExecutingAssembly(),
            "Ai.Tlbx.MiddleManager");
#endif

        app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = fileProvider });

        var contentTypeProvider = new FileExtensionContentTypeProvider();
        contentTypeProvider.Mappings[".ico"] = "image/x-icon";
        contentTypeProvider.Mappings[".webmanifest"] = "application/manifest+json";

        app.UseStaticFiles(new StaticFileOptions
        {
            FileProvider = fileProvider,
            ContentTypeProvider = contentTypeProvider,
            OnPrepareResponse = ctx =>
            {
                ctx.Context.Response.Headers.Remove("ETag");
                ctx.Context.Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
                ctx.Context.Response.Headers.Pragma = "no-cache";
            }
        });

        app.UseWebSockets();
    }

    private static void ConfigureAuthMiddleware(WebApplication app, SettingsService settingsService, AuthService authService)
    {
        var cookieOptions = new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Strict,
            Secure = false, // Allow HTTP for localhost
            MaxAge = TimeSpan.FromHours(24)
        };

        // Auth middleware - runs before all requests
        app.Use(async (context, next) =>
        {
            var authSettings = settingsService.Load();
            var path = context.Request.Path.Value ?? "";

            // Skip auth if disabled
            if (!authSettings.AuthenticationEnabled || string.IsNullOrEmpty(authSettings.PasswordHash))
            {
                await next();
                return;
            }

            // Public paths that don't require auth
            if (path == "/login" || path == "/login.html" ||
                path.StartsWith("/api/auth/") ||
                path.StartsWith("/css/") ||
                path.StartsWith("/js/") ||
                path.EndsWith(".ico") ||
                path.EndsWith(".webmanifest"))
            {
                await next();
                return;
            }

            // Check session cookie
            var token = context.Request.Cookies["mm-session"];
            if (token is not null && authService.ValidateSessionToken(token))
            {
                // Refresh cookie (sliding expiration)
                context.Response.Cookies.Append("mm-session", token, cookieOptions);
                await next();
                return;
            }

            // API/WebSocket requests: return 401
            if (path.StartsWith("/api/") || path.StartsWith("/ws/"))
            {
                context.Response.StatusCode = 401;
                return;
            }

            // Page requests: redirect to login
            context.Response.Redirect("/login.html");
        });

        // Auth endpoints
        app.MapPost("/api/auth/login", async (HttpContext ctx) =>
        {
            var ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";

            if (authService.IsRateLimited(ip))
            {
                var remaining = authService.GetRemainingLockout(ip);
                return Results.Json(new AuthResponse { Success = false, Error = $"Too many attempts. Try again in {remaining?.TotalSeconds:0} seconds." },
                    AppJsonContext.Default.AuthResponse, statusCode: 429);
            }

            LoginRequest? request;
            try
            {
                request = await ctx.Request.ReadFromJsonAsync(AppJsonContext.Default.LoginRequest);
            }
            catch
            {
                return Results.Json(new AuthResponse { Success = false, Error = "Invalid request" },
                    AppJsonContext.Default.AuthResponse, statusCode: 400);
            }

            if (request is null || string.IsNullOrEmpty(request.Password))
            {
                return Results.Json(new AuthResponse { Success = false, Error = "Password required" },
                    AppJsonContext.Default.AuthResponse, statusCode: 400);
            }

            var loginSettings = settingsService.Load();
            if (!authService.VerifyPassword(request.Password, loginSettings.PasswordHash))
            {
                authService.RecordFailedAttempt(ip);
                return Results.Json(new AuthResponse { Success = false, Error = "Invalid password" },
                    AppJsonContext.Default.AuthResponse, statusCode: 401);
            }

            authService.ResetAttempts(ip);
            var token = authService.CreateSessionToken();
            ctx.Response.Cookies.Append("mm-session", token, cookieOptions);

            return Results.Json(new AuthResponse { Success = true }, AppJsonContext.Default.AuthResponse);
        });

        app.MapPost("/api/auth/logout", (HttpContext ctx) =>
        {
            ctx.Response.Cookies.Delete("mm-session");
            return Results.Ok();
        });

        app.MapPost("/api/auth/change-password", async (HttpContext ctx) =>
        {
            ChangePasswordRequest? request;
            try
            {
                request = await ctx.Request.ReadFromJsonAsync(AppJsonContext.Default.ChangePasswordRequest);
            }
            catch
            {
                return Results.Json(new AuthResponse { Success = false, Error = "Invalid request" },
                    AppJsonContext.Default.AuthResponse, statusCode: 400);
            }

            if (request is null || string.IsNullOrEmpty(request.NewPassword))
            {
                return Results.Json(new AuthResponse { Success = false, Error = "New password required" },
                    AppJsonContext.Default.AuthResponse, statusCode: 400);
            }

            var pwSettings = settingsService.Load();

            // If password exists, verify current password
            if (!string.IsNullOrEmpty(pwSettings.PasswordHash))
            {
                if (string.IsNullOrEmpty(request.CurrentPassword) ||
                    !authService.VerifyPassword(request.CurrentPassword, pwSettings.PasswordHash))
                {
                    return Results.Json(new AuthResponse { Success = false, Error = "Current password is incorrect" },
                        AppJsonContext.Default.AuthResponse, statusCode: 401);
                }
            }

            // Set new password
            pwSettings.PasswordHash = authService.HashPassword(request.NewPassword);
            pwSettings.AuthenticationEnabled = true;
            authService.InvalidateAllSessions();
            settingsService.Save(pwSettings);

            // Set new session cookie
            var token = authService.CreateSessionToken();
            ctx.Response.Cookies.Append("mm-session", token, cookieOptions);

            return Results.Json(new AuthResponse { Success = true }, AppJsonContext.Default.AuthResponse);
        });

        app.MapGet("/api/auth/status", () =>
        {
            var statusSettings = settingsService.Load();
            return Results.Json(new AuthStatusResponse
            {
                AuthenticationEnabled = statusSettings.AuthenticationEnabled,
                PasswordSet = !string.IsNullOrEmpty(statusSettings.PasswordHash)
            }, AppJsonContext.Default.AuthStatusResponse);
        });
    }

    private static void MapApiEndpoints(
        WebApplication app,
        ConHostSessionManager? conHostManager,
        SessionManager? directManager,
        UpdateService updateService,
        string version)
    {
        var shellRegistry = directManager?.ShellRegistry ?? app.Services.GetRequiredService<ShellRegistry>();
        var settingsService = directManager?.SettingsService ?? app.Services.GetRequiredService<SettingsService>();

        app.MapGet("/api/version", () => Results.Text(version));

        app.MapGet("/api/health", () =>
        {
            var isConHostMode = conHostManager is not null;
            var sessionCount = conHostManager?.GetAllSessions().Count
                ?? directManager?.GetSessionList().Sessions?.Count ?? 0;

            var mode = isConHostMode ? "service" : "direct";

            var health = new SystemHealth
            {
                Healthy = true,
                Mode = mode,
                SessionCount = sessionCount,
                Version = version,
                WebProcessId = Environment.ProcessId,
                UptimeSeconds = (long)(DateTime.UtcNow - System.Diagnostics.Process.GetCurrentProcess().StartTime.ToUniversalTime()).TotalSeconds,
                Platform = OperatingSystem.IsWindows() ? "Windows" : OperatingSystem.IsMacOS() ? "macOS" : "Linux"
            };
            return Results.Json(health, AppJsonContext.Default.SystemHealth);
        });

        app.MapGet("/api/version/details", () =>
        {
            var manifest = updateService.InstalledManifest;
            return Results.Json(manifest, AppJsonContext.Default.VersionManifest);
        });

        app.MapGet("/api/update/check", async () =>
        {
            var update = await updateService.CheckForUpdateAsync();
            return Results.Json(update ?? new UpdateInfo
            {
                Available = false,
                CurrentVersion = updateService.CurrentVersion,
                LatestVersion = updateService.CurrentVersion
            }, AppJsonContext.Default.UpdateInfo);
        });

        app.MapPost("/api/update/apply", async () =>
        {
            var update = updateService.LatestUpdate;
            if (update is null || !update.Available)
            {
                return Results.BadRequest("No update available");
            }

            var extractedDir = await updateService.DownloadUpdateAsync();
            if (string.IsNullOrEmpty(extractedDir))
            {
                return Results.Problem("Failed to download update");
            }

            var scriptPath = UpdateScriptGenerator.GenerateUpdateScript(extractedDir, UpdateService.GetCurrentBinaryPath());

            _ = Task.Run(async () =>
            {
                await Task.Delay(1000);
                UpdateScriptGenerator.ExecuteUpdateScript(scriptPath);
                Environment.Exit(0);
            });

            return Results.Ok("Update started. Server will restart shortly.");
        });

        app.MapGet("/api/networks", () =>
        {
            var interfaces = System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces()
                .Where(ni => ni.OperationalStatus == System.Net.NetworkInformation.OperationalStatus.Up
                             && ni.NetworkInterfaceType != System.Net.NetworkInformation.NetworkInterfaceType.Loopback)
                .SelectMany(ni => ni.GetIPProperties().UnicastAddresses
                    .Where(addr => addr.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                    .Select(addr => new NetworkInterfaceDto
                    {
                        Name = ni.Name,
                        Ip = addr.Address.ToString()
                    }))
                .ToList();
            return Results.Json(interfaces, AppJsonContext.Default.ListNetworkInterfaceDto);
        });

        app.MapGet("/api/shells", () =>
        {
            var shells = shellRegistry.GetAllShells().Select(s => new ShellInfoDto
            {
                Type = s.ShellType.ToString(),
                DisplayName = s.DisplayName,
                IsAvailable = s.IsAvailable(),
                SupportsOsc7 = s.SupportsOsc7
            }).ToList();
            return Results.Json(shells, AppJsonContext.Default.ListShellInfoDto);
        });

        app.MapGet("/api/settings", () =>
        {
            var settings = settingsService.Load();
            return Results.Json(settings, AppJsonContext.Default.MiddleManagerSettings);
        });

        app.MapPut("/api/settings", (MiddleManagerSettings settings) =>
        {
            settingsService.Save(settings);
            return Results.Ok();
        });

        app.MapGet("/api/users", () =>
        {
            var users = UserEnumerationService.GetSystemUsers();
            return Results.Json(users, AppJsonContext.Default.ListUserInfo);
        });

        app.MapGet("/api/sessions", () =>
        {
            if (conHostManager is not null)
            {
                var sessions = conHostManager.GetAllSessions();
                var list = new SessionListDto
                {
                    Sessions = sessions.Select(s => new SessionInfoDto
                    {
                        Id = s.Id,
                        Pid = s.Pid,
                        CreatedAt = s.CreatedAt,
                        IsRunning = s.IsRunning,
                        ExitCode = s.ExitCode,
                        CurrentWorkingDirectory = s.CurrentWorkingDirectory,
                        Cols = s.Cols,
                        Rows = s.Rows,
                        ShellType = s.ShellType,
                        Name = s.Name
                    }).ToList()
                };
                return Results.Json(list, AppJsonContext.Default.SessionListDto);
            }
            return Results.Json(directManager!.GetSessionList(), AppJsonContext.Default.SessionListDto);
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

            if (conHostManager is not null)
            {
                var sessionInfo = await conHostManager.CreateSessionAsync(shellType?.ToString(), cols, rows, request?.WorkingDirectory);
                if (sessionInfo is null)
                {
                    return Results.Problem("Failed to create session");
                }
                var info = new SessionInfoDto
                {
                    Id = sessionInfo.Id,
                    Pid = sessionInfo.Pid,
                    CreatedAt = sessionInfo.CreatedAt,
                    IsRunning = sessionInfo.IsRunning,
                    ExitCode = sessionInfo.ExitCode,
                    CurrentWorkingDirectory = sessionInfo.CurrentWorkingDirectory,
                    Cols = sessionInfo.Cols,
                    Rows = sessionInfo.Rows,
                    ShellType = sessionInfo.ShellType,
                    Name = sessionInfo.Name
                };
                return Results.Json(info, AppJsonContext.Default.SessionInfoDto);
            }
            else
            {
                var session = directManager!.CreateSession(cols, rows, shellType);
                var info = new SessionInfoDto
                {
                    Id = session.Id,
                    Pid = session.Pid,
                    CreatedAt = session.CreatedAt,
                    IsRunning = session.IsRunning,
                    ExitCode = session.ExitCode,
                    CurrentWorkingDirectory = session.CurrentWorkingDirectory,
                    Cols = session.Cols,
                    Rows = session.Rows,
                    ShellType = session.ShellType.ToString(),
                    Name = session.Name,
                    LastActiveViewerId = session.LastActiveViewerId
                };
                return Results.Json(info, AppJsonContext.Default.SessionInfoDto);
            }
        });

        app.MapDelete("/api/sessions/{id}", async (string id) =>
        {
            if (conHostManager is not null)
            {
                await conHostManager.CloseSessionAsync(id);
            }
            else
            {
                directManager!.CloseSession(id);
            }
            return Results.Ok();
        });

        app.MapPost("/api/sessions/{id}/resize", async (string id, ResizeRequest request) =>
        {
            if (conHostManager is not null)
            {
                var session = conHostManager.GetSession(id);
                if (session is null)
                {
                    return Results.NotFound();
                }
                await conHostManager.ResizeSessionAsync(id, request.Cols, request.Rows);
                return Results.Json(new ResizeResponse
                {
                    Accepted = true,
                    Cols = request.Cols,
                    Rows = request.Rows
                }, AppJsonContext.Default.ResizeResponse);
            }
            else
            {
                var session = directManager!.GetSession(id);
                if (session is null)
                {
                    return Results.NotFound();
                }
                var accepted = session.Resize(request.Cols, request.Rows, request.ViewerId);
                return Results.Json(new ResizeResponse
                {
                    Accepted = accepted,
                    Cols = session.Cols,
                    Rows = session.Rows
                }, AppJsonContext.Default.ResizeResponse);
            }
        });

        app.MapGet("/api/sessions/{id}/buffer", async (string id) =>
        {
            if (conHostManager is not null)
            {
                var session = conHostManager.GetSession(id);
                if (session is null)
                {
                    return Results.NotFound();
                }
                var buffer = await conHostManager.GetBufferAsync(id);
                return Results.Bytes(buffer ?? []);
            }
            else
            {
                var session = directManager!.GetSession(id);
                if (session is null)
                {
                    return Results.NotFound();
                }
                return Results.Text(session.GetBuffer());
            }
        });

        app.MapPut("/api/sessions/{id}/name", async (string id, RenameSessionRequest request) =>
        {
            if (conHostManager is not null)
            {
                if (!await conHostManager.SetSessionNameAsync(id, request.Name))
                {
                    return Results.NotFound();
                }
                return Results.Ok();
            }
            else
            {
                if (!directManager!.RenameSession(id, request.Name))
                {
                    return Results.NotFound();
                }
                return Results.Ok();
            }
        });
    }

    private static void MapWebSocketMiddleware(
        WebApplication app,
        ConHostSessionManager? conHostManager,
        SessionManager? directManager,
        ConHostMuxConnectionManager? conHostMuxManager,
        MuxConnectionManager? directMuxManager,
        UpdateService updateService)
    {
        app.Use(async (context, next) =>
        {
            if (!context.Request.Path.StartsWithSegments("/ws"))
            {
                await next(context);
                return;
            }

            if (!context.WebSockets.IsWebSocketRequest)
            {
                context.Response.StatusCode = 400;
                return;
            }

            var path = context.Request.Path.Value ?? "";

            if (path == "/ws/state")
            {
                await HandleStateWebSocketAsync(context, conHostManager, directManager, updateService);
                return;
            }

            if (path == "/ws/mux")
            {
                await HandleMuxWebSocketAsync(context, conHostManager, directManager, conHostMuxManager, directMuxManager);
                return;
            }

            context.Response.StatusCode = 404;
        });
    }

    private static void RunWithPortErrorHandling(WebApplication app, int port, string bindAddress)
    {
        try
        {
            app.Run($"http://{bindAddress}:{port}");
        }
        catch (IOException ex) when (ex.InnerException is System.Net.Sockets.SocketException socketEx &&
            socketEx.SocketErrorCode == System.Net.Sockets.SocketError.AddressAlreadyInUse)
        {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  Error: Port {port} is already in use by another process.");
            Console.ResetColor();
            Console.WriteLine();
            Console.WriteLine($"  Try one of the following:");
            Console.WriteLine($"    - Close the application using port {port}");
            Console.WriteLine($"    - Use a different port: mm --port 2001");
            Console.WriteLine();
            Environment.Exit(1);
        }
    }

    private static async Task HandleMuxWebSocketAsync(
        HttpContext context,
        ConHostSessionManager? conHostManager,
        SessionManager? directManager,
        ConHostMuxConnectionManager? conHostMuxManager,
        MuxConnectionManager? directMuxManager)
    {
        using var ws = await context.WebSockets.AcceptWebSocketAsync();
        var clientId = Guid.NewGuid().ToString("N");

        MuxClient client;
        if (conHostMuxManager is not null)
        {
            client = conHostMuxManager.AddClient(clientId, ws);
        }
        else
        {
            client = directMuxManager!.AddClient(clientId, ws);
        }

        try
        {
            var initFrame = new byte[MuxProtocol.HeaderSize + 32];
            initFrame[0] = 0xFF;
            Encoding.ASCII.GetBytes(clientId.AsSpan(0, 8), initFrame.AsSpan(1, 8));
            Encoding.UTF8.GetBytes(clientId, initFrame.AsSpan(MuxProtocol.HeaderSize));
            await client.SendAsync(initFrame);

            // Send initial buffer for existing sessions
            if (conHostManager is not null)
            {
                var sessions = conHostManager.GetAllSessions();
                foreach (var sessionInfo in sessions)
                {
                    var buffer = await conHostManager.GetBufferAsync(sessionInfo.Id);
                    if (buffer is not null && buffer.Length > 0)
                    {
                        var frame = MuxProtocol.CreateOutputFrame(sessionInfo.Id, buffer);
                        await client.SendAsync(frame);
                    }
                }
            }
            else
            {
                foreach (var session in directManager!.Sessions)
                {
                    var buffer = session.GetBuffer();
                    if (!string.IsNullOrEmpty(buffer))
                    {
                        var bufferBytes = Encoding.UTF8.GetBytes(buffer);
                        var frame = MuxProtocol.CreateOutputFrame(session.Id, bufferBytes);
                        await client.SendAsync(frame);
                    }
                }
            }

            var receiveBuffer = new byte[MuxProtocol.MaxFrameSize];

            while (ws.State == WebSocketState.Open)
            {
                WebSocketReceiveResult result;
                try
                {
                    result = await ws.ReceiveAsync(receiveBuffer, CancellationToken.None);
                }
                catch (WebSocketException)
                {
                    break;
                }

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    break;
                }

                if (result.MessageType == WebSocketMessageType.Binary && result.Count >= MuxProtocol.HeaderSize)
                {
                    if (MuxProtocol.TryParseFrame(receiveBuffer.AsSpan(0, result.Count), out var type, out var sessionId, out var payload))
                    {
                        switch (type)
                        {
                            case MuxProtocol.TypeTerminalInput:
                                if (payload.Length < 20)
                                {
                                    DebugLog($"[WS-INPUT] {sessionId}: {BitConverter.ToString(payload.ToArray())}");
                                }
                                if (conHostMuxManager is not null)
                                {
                                    await conHostMuxManager.HandleInputAsync(sessionId, new ReadOnlyMemory<byte>(payload.ToArray()), clientId);
                                }
                                else
                                {
                                    await directMuxManager!.HandleInputAsync(sessionId, payload.ToArray(), clientId);
                                }
                                break;

                            case MuxProtocol.TypeResize:
                                var (cols, rows) = MuxProtocol.ParseResizePayload(payload);
                                if (conHostMuxManager is not null)
                                {
                                    await conHostMuxManager.HandleResizeAsync(sessionId, cols, rows, clientId);
                                }
                                else
                                {
                                    directMuxManager!.HandleResize(sessionId, cols, rows, clientId);
                                }
                                break;
                        }
                    }
                }
            }
        }
        finally
        {
            if (conHostMuxManager is not null)
            {
                conHostMuxManager.RemoveClient(clientId);
            }
            else
            {
                directMuxManager!.RemoveClient(clientId);
            }

            if (ws.State == WebSocketState.Open)
            {
                try
                {
                    await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
                }
                catch
                {
                }
            }
        }
    }

    private static async Task HandleStateWebSocketAsync(
        HttpContext context,
        ConHostSessionManager? conHostManager,
        SessionManager? directManager,
        UpdateService updateService)
    {
        using var ws = await context.WebSockets.AcceptWebSocketAsync();
        var sendLock = new SemaphoreSlim(1, 1);
        UpdateInfo? lastUpdate = null;

        async Task SendStateAsync()
        {
            if (ws.State != WebSocketState.Open)
            {
                return;
            }

            await sendLock.WaitAsync();
            try
            {
                if (ws.State != WebSocketState.Open)
                {
                    return;
                }

                var sessionList = conHostManager?.GetSessionList() ?? directManager!.GetSessionList();
                var state = new StateUpdate
                {
                    Sessions = sessionList,
                    Update = lastUpdate
                };
                var json = JsonSerializer.Serialize(state, AppJsonContext.Default.StateUpdate);
                var bytes = Encoding.UTF8.GetBytes(json);
                await ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch
            {
            }
            finally
            {
                sendLock.Release();
            }
        }

        void OnStateChange() => _ = SendStateAsync();

        void OnUpdateAvailable(UpdateInfo update)
        {
            lastUpdate = update;
            _ = SendStateAsync();
        }

        string sessionListenerId;
        if (conHostManager is not null)
        {
            sessionListenerId = conHostManager.AddStateListener(OnStateChange);
        }
        else
        {
            sessionListenerId = directManager!.AddStateListener(OnStateChange);
        }
        var updateListenerId = updateService.AddUpdateListener(OnUpdateAvailable);

        try
        {
            lastUpdate = updateService.LatestUpdate;
            await SendStateAsync();

            var buffer = new byte[1024];
            while (ws.State == WebSocketState.Open)
            {
                try
                {
                    var result = await ws.ReceiveAsync(buffer, CancellationToken.None);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        break;
                    }
                }
                catch
                {
                    break;
                }
            }
        }
        finally
        {
            if (conHostManager is not null)
            {
                conHostManager.RemoveStateListener(sessionListenerId);
            }
            else
            {
                directManager!.RemoveStateListener(sessionListenerId);
            }
            updateService.RemoveUpdateListener(updateListenerId);
            sendLock.Dispose();

            if (ws.State == WebSocketState.Open)
            {
                try
                {
                    await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
                }
                catch
                {
                }
            }
        }
    }

    private static void PrintWelcomeBanner(int port, string bindAddress, SettingsService settingsService, string version, string modeDescription)
    {
        var settings = settingsService.Load();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine();
        Console.WriteLine(@"  __  __ _     _     _ _      __  __");
        Console.WriteLine(@" |  \/  (_) __| | __| | | ___|  \/  | __ _ _ __   __ _  __ _  ___ _ __");
        Console.WriteLine(@" | |\/| | |/ _` |/ _` | |/ _ \ |\/| |/ _` | '_ \ / _` |/ _` |/ _ \ '__|");
        Console.WriteLine(@" | |  | | | (_| | (_| | |  __/ |  | | (_| | | | | (_| | (_| |  __/ |");
        Console.WriteLine(@" |_|  |_|_|\__,_|\__,_|_|\___|_|  |_|\__,_|_| |_|\__,_|\__, |\___|_|");
        Console.ForegroundColor = ConsoleColor.Green;
        Console.Write(@"   by Johannes Schmidt - https://github.com/AiTlbx");
        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine(@"     |___/");


        Console.ResetColor();
        Console.WriteLine();

        var platform = OperatingSystem.IsWindows() ? "Windows"
            : OperatingSystem.IsMacOS() ? "macOS"
            : OperatingSystem.IsLinux() ? "Linux"
            : "Unknown";

        Console.WriteLine($"  Version:  {version}");
        Console.WriteLine($"  Platform: {platform}");
        Console.WriteLine($"  Shell:    {settings.DefaultShell}");
        Console.Write($"  Mode:     ");
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine(modeDescription);
        Console.ResetColor();
        Console.WriteLine();
        Console.WriteLine($"  Listening on http://{bindAddress}:{port}");
        Console.WriteLine();

        switch (settingsService.LoadStatus)
        {
            case SettingsLoadStatus.LoadedFromFile:
                Console.WriteLine($"  Settings: Loaded from {settingsService.SettingsPath}");
                break;
            case SettingsLoadStatus.ErrorFallbackToDefault:
                Console.ForegroundColor = ConsoleColor.Yellow;
                Console.WriteLine($"  Settings: Error loading {settingsService.SettingsPath}");
                Console.WriteLine($"            {settingsService.LoadError}");
                Console.WriteLine($"            Using default settings");
                Console.ResetColor();
                break;
            default:
                Console.WriteLine($"  Settings: Using defaults (no settings file)");
                break;
        }

        Console.WriteLine();
    }
}
