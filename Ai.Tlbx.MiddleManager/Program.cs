using System.Reflection;
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

        var (port, bindAddress, useConHost) = ParseCommandLineArgs(args);
        var builder = CreateBuilder(args);
        var app = builder.Build();
        var version = GetVersion();

        ConfigureStaticFiles(app);

        var settingsService = app.Services.GetRequiredService<SettingsService>();
        var updateService = app.Services.GetRequiredService<UpdateService>();
        var authService = app.Services.GetRequiredService<AuthService>();

        var settings = settingsService.Load();
        DebugLogger.Enabled = settings.DebugLogging;
        if (DebugLogger.Enabled)
        {
            DebugLogger.ClearLogs();
            DebugLogger.Log("Debug logging enabled");
        }

        // Session managers
        ConHostSessionManager? conHostSessionManager = null;
        ConHostMuxConnectionManager? conHostMuxManager = null;
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

        // Configure middleware and endpoints
        AuthEndpoints.ConfigureAuthMiddleware(app, settingsService, authService);
        AuthEndpoints.MapAuthEndpoints(app, settingsService, authService);
        MapSystemEndpoints(app, conHostSessionManager, directSessionManager, updateService, settingsService, version);
        SessionApiEndpoints.MapSessionEndpoints(app, conHostSessionManager, directSessionManager);
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

    private static void MapSystemEndpoints(
        WebApplication app,
        ConHostSessionManager? conHostManager,
        SessionManager? directManager,
        UpdateService updateService,
        SettingsService settingsService,
        string version)
    {
        var shellRegistry = directManager?.ShellRegistry ?? app.Services.GetRequiredService<ShellRegistry>();

        app.MapGet("/api/version", () => Results.Text(version));

        app.MapGet("/api/health", () =>
        {
            var isConHostMode = conHostManager is not null;
            var sessionCount = conHostManager?.GetAllSessions().Count
                ?? directManager?.GetSessionList().Sessions?.Count ?? 0;

            var mode = isConHostMode ? "service" : "direct";

            string? conHostVersion = null;
            string? conHostExpected = null;
            bool? conHostCompatible = null;

            if (OperatingSystem.IsWindows() && isConHostMode)
            {
                conHostVersion = ConHostSpawner.GetConHostVersion();
                var manifest = updateService.InstalledManifest;
                conHostExpected = manifest.Pty;
                conHostCompatible = conHostVersion == conHostExpected ||
                    (conHostVersion is not null && manifest.MinCompatiblePty is not null &&
                     UpdateService.CompareVersions(conHostVersion, manifest.MinCompatiblePty) >= 0);
            }

            var health = new SystemHealth
            {
                Healthy = true,
                Mode = mode,
                SessionCount = sessionCount,
                Version = version,
                WebProcessId = Environment.ProcessId,
                UptimeSeconds = (long)(DateTime.UtcNow - System.Diagnostics.Process.GetCurrentProcess().StartTime.ToUniversalTime()).TotalSeconds,
                Platform = OperatingSystem.IsWindows() ? "Windows" : OperatingSystem.IsMacOS() ? "macOS" : "Linux",
                ConHostVersion = conHostVersion,
                ConHostExpected = conHostExpected,
                ConHostCompatible = conHostCompatible
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
    }

    private static void MapWebSocketMiddleware(
        WebApplication app,
        ConHostSessionManager? conHostManager,
        SessionManager? directManager,
        ConHostMuxConnectionManager? conHostMuxManager,
        MuxConnectionManager? directMuxManager,
        UpdateService updateService)
    {
        var muxHandler = new MuxWebSocketHandler(conHostManager, directManager, conHostMuxManager, directMuxManager);
        var stateHandler = new StateWebSocketHandler(conHostManager, directManager, updateService);

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
                await stateHandler.HandleAsync(context);
                return;
            }

            if (path == "/ws/mux")
            {
                await muxHandler.HandleAsync(context);
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
