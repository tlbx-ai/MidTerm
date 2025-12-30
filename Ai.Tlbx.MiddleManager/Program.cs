using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MiddleManager.Ipc;
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

    public static async Task Main(string[] args)
    {
        if (HandleSpecialCommands(args))
        {
            return;
        }

        var (port, bindAddress, useSidecar, wasSpawned) = ParseCommandLineArgs(args);
        var builder = CreateBuilder(args);
        var app = builder.Build();
        var version = GetVersion();

        ConfigureStaticFiles(app);

        var settingsService = app.Services.GetRequiredService<SettingsService>();
        var shellRegistry = app.Services.GetRequiredService<ShellRegistry>();
        var updateService = app.Services.GetRequiredService<UpdateService>();

        SidecarSessionManager? sidecarSessionManager = null;
        SidecarMuxConnectionManager? sidecarMuxManager = null;
        SidecarLifecycle? sidecarLifecycle = null;

        if (useSidecar)
        {
            sidecarLifecycle = new SidecarLifecycle(settingsService, wasSpawned);
            if (await sidecarLifecycle.StartAndConnectAsync())
            {
                sidecarSessionManager = new SidecarSessionManager(shellRegistry, settingsService, sidecarLifecycle.Client);
                sidecarMuxManager = new SidecarMuxConnectionManager(sidecarSessionManager);
                sidecarSessionManager.SetMuxManager(sidecarMuxManager);
                await sidecarSessionManager.SyncSessionsAsync();
                Console.WriteLine("Running in sidecar mode (sessions persist across restarts)");
            }
            else if (wasSpawned)
            {
                Console.WriteLine("Error: Could not connect to parent mm-host. Exiting.");
                return;
            }
            else
            {
                Console.WriteLine("Warning: Could not connect to mm-host, falling back to direct mode");
                await sidecarLifecycle.DisposeAsync();
                sidecarLifecycle = null;
            }
        }

        SessionManager? directSessionManager = null;
        MuxConnectionManager? directMuxManager = null;

        if (sidecarSessionManager is null)
        {
            directSessionManager = app.Services.GetRequiredService<SessionManager>();
            directMuxManager = new MuxConnectionManager(directSessionManager);
            directSessionManager.SetMuxManager(directMuxManager);
        }

        MapApiEndpoints(app, sidecarSessionManager, directSessionManager, updateService, version);
        MapWebSocketMiddleware(app, sidecarSessionManager, directSessionManager, sidecarMuxManager, directMuxManager, updateService);

        PrintWelcomeBanner(port, bindAddress, settingsService, version, sidecarSessionManager is not null);
        RunWithPortErrorHandling(app, port, bindAddress);

        // Cleanup
        if (sidecarLifecycle is not null)
        {
            await sidecarLifecycle.DisposeAsync();
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

        return false;
    }

    private static (int port, string bindAddress, bool useSidecar, bool wasSpawned) ParseCommandLineArgs(string[] args)
    {
        var port = DefaultPort;
        var bindAddress = DefaultBindAddress;
        var useSidecar = !args.Contains("--no-sidecar");
        var wasSpawned = args.Contains("--spawned");

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

        return (port, bindAddress, useSidecar, wasSpawned);
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

    private static void MapApiEndpoints(
        WebApplication app,
        SidecarSessionManager? sidecarManager,
        SessionManager? directManager,
        UpdateService updateService,
        string version)
    {
        var shellRegistry = sidecarManager?.ShellRegistry ?? directManager!.ShellRegistry;
        var settingsService = sidecarManager?.SettingsService ?? directManager!.SettingsService;

        app.MapGet("/api/version", () => Results.Text(version));

        app.MapGet("/api/health", () =>
        {
            var isSidecarMode = sidecarManager is not null;
            var hostConnected = sidecarManager?.IsConnected ?? true;
            var sessionCount = sidecarManager?.GetSessionList().Sessions?.Count
                ?? directManager?.GetSessionList().Sessions?.Count ?? 0;

            var health = new SystemHealth
            {
                Healthy = !isSidecarMode || hostConnected,
                Mode = isSidecarMode ? "sidecar" : "direct",
                HostConnected = hostConnected,
                HostError = isSidecarMode && !hostConnected ? "Cannot connect to mm-host process" : null,
                SessionCount = sessionCount,
                Version = version
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
            var list = sidecarManager?.GetSessionList() ?? directManager!.GetSessionList();
            return Results.Json(list, AppJsonContext.Default.SessionListDto);
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

            if (sidecarManager is not null)
            {
                var snapshot = await sidecarManager.CreateSessionAsync(cols, rows, shellType);
                if (snapshot is null)
                {
                    return Results.Problem("Failed to create session");
                }
                var info = new SessionInfoDto
                {
                    Id = snapshot.Id,
                    Pid = snapshot.Pid,
                    CreatedAt = snapshot.CreatedAt,
                    IsRunning = snapshot.IsRunning,
                    ExitCode = snapshot.ExitCode,
                    CurrentWorkingDirectory = snapshot.CurrentWorkingDirectory,
                    Cols = snapshot.Cols,
                    Rows = snapshot.Rows,
                    ShellType = snapshot.ShellType,
                    Name = snapshot.Name,
                    LastActiveViewerId = null
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
            if (sidecarManager is not null)
            {
                await sidecarManager.CloseSessionAsync(id);
            }
            else
            {
                directManager!.CloseSession(id);
            }
            return Results.Ok();
        });

        app.MapPost("/api/sessions/{id}/resize", async (string id, ResizeRequest request) =>
        {
            if (sidecarManager is not null)
            {
                var session = sidecarManager.GetSession(id);
                if (session is null)
                {
                    return Results.NotFound();
                }
                await sidecarManager.ResizeAsync(id, request.Cols, request.Rows);
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
            if (sidecarManager is not null)
            {
                var session = sidecarManager.GetSession(id);
                if (session is null)
                {
                    return Results.NotFound();
                }
                var buffer = await sidecarManager.GetBufferAsync(id);
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

        app.MapPut("/api/sessions/{id}/name", (string id, RenameSessionRequest request) =>
        {
            if (sidecarManager is not null)
            {
                // TODO: Implement rename via sidecar
                return Results.NotFound();
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
        SidecarSessionManager? sidecarManager,
        SessionManager? directManager,
        SidecarMuxConnectionManager? sidecarMuxManager,
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
                await HandleStateWebSocketAsync(context, sidecarManager, directManager, updateService);
                return;
            }

            if (path == "/ws/mux")
            {
                await HandleMuxWebSocketAsync(context, sidecarManager, directManager, sidecarMuxManager, directMuxManager);
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
        SidecarSessionManager? sidecarManager,
        SessionManager? directManager,
        SidecarMuxConnectionManager? sidecarMuxManager,
        MuxConnectionManager? directMuxManager)
    {
        using var ws = await context.WebSockets.AcceptWebSocketAsync();
        var clientId = Guid.NewGuid().ToString("N");

        MuxClient client;
        if (sidecarMuxManager is not null)
        {
            client = sidecarMuxManager.AddClient(clientId, ws);
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
            if (sidecarManager is not null)
            {
                var sessionList = sidecarManager.GetSessionList();
                foreach (var sessionInfo in sessionList.Sessions)
                {
                    var buffer = await sidecarManager.GetBufferAsync(sessionInfo.Id);
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
                                if (sidecarMuxManager is not null)
                                {
                                    await sidecarMuxManager.HandleInputAsync(sessionId, new ReadOnlyMemory<byte>(payload.ToArray()), clientId);
                                }
                                else
                                {
                                    await directMuxManager!.HandleInputAsync(sessionId, payload.ToArray(), clientId);
                                }
                                break;

                            case MuxProtocol.TypeResize:
                                var (cols, rows) = MuxProtocol.ParseResizePayload(payload);
                                if (sidecarMuxManager is not null)
                                {
                                    await sidecarMuxManager.HandleResizeAsync(sessionId, cols, rows, clientId);
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
            if (sidecarMuxManager is not null)
            {
                sidecarMuxManager.RemoveClient(clientId);
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
        SidecarSessionManager? sidecarManager,
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

                var sessionList = sidecarManager?.GetSessionList() ?? directManager!.GetSessionList();
                var hostConnected = sidecarManager?.IsConnected ?? true;
                var state = new StateUpdate
                {
                    Sessions = sessionList,
                    Update = lastUpdate,
                    HostConnected = hostConnected
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
        if (sidecarManager is not null)
        {
            sessionListenerId = sidecarManager.AddStateListener(OnStateChange);
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
            if (sidecarManager is not null)
            {
                sidecarManager.RemoveStateListener(sessionListenerId);
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

    private static void PrintWelcomeBanner(int port, string bindAddress, SettingsService settingsService, string version, bool sidecarMode)
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
        if (sidecarMode)
        {
            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine("Sidecar (sessions persist across restarts)");
            Console.ResetColor();
        }
        else
        {
            Console.WriteLine("Direct (sessions lost on restart)");
        }
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
