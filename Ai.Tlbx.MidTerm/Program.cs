using System.Reflection;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Settings;
using Ai.Tlbx.MidTerm.Common.Shells;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;

namespace Ai.Tlbx.MidTerm;

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

        // Ensure only one mt.exe instance runs system-wide
        var instanceGuard = SingleInstanceGuard.TryAcquire(out var existingInfo);
        if (instanceGuard is null)
        {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: {existingInfo}");
            Console.ResetColor();
            Console.WriteLine("Only one instance of MidTerm can run at a time.");
            Console.WriteLine("Stop the existing instance before starting a new one.");
            Environment.Exit(1);
            return;
        }

        var (port, bindAddress) = ParseCommandLineArgs(args);
        var builder = CreateBuilder(args);
        var app = builder.Build();
        var version = GetVersion();

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

        // Auth middleware must run BEFORE static files so unauthenticated users get redirected to login
        AuthEndpoints.ConfigureAuthMiddleware(app, settingsService, authService);
        ConfigureStaticFiles(app);

        // Session manager - always uses ConHost (spawned subprocess per terminal)
        var sessionManager = new TtyHostSessionManager(runAsUser: settings.RunAsUser);
        var muxManager = new TtyHostMuxConnectionManager(sessionManager);
        await sessionManager.DiscoverExistingSessionsAsync();

        // Configure remaining endpoints
        AuthEndpoints.MapAuthEndpoints(app, settingsService, authService);
        MapSystemEndpoints(app, sessionManager, updateService, settingsService, version);
        SessionApiEndpoints.MapSessionEndpoints(app, sessionManager);
        MapWebSocketMiddleware(app, sessionManager, muxManager, updateService);

        // Register cleanup for graceful shutdown (service restart, Ctrl+C)
        var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();
        lifetime.ApplicationStopping.Register(() =>
        {
            Console.WriteLine("Shutdown requested, cleaning up...");
            // Fire-and-forget cleanup with timeout - don't block service stop
            var cleanupTask = Task.Run(async () =>
            {
                try
                {
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                    await muxManager.DisposeAsync().AsTask().WaitAsync(cts.Token);
                    await sessionManager.DisposeAsync().AsTask().WaitAsync(cts.Token);
                }
                catch (OperationCanceledException)
                {
                    Console.WriteLine("Cleanup timed out, forcing exit");
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"Cleanup error: {ex.Message}");
                }
                finally
                {
                    instanceGuard.Dispose();
                }
            });
            cleanupTask.Wait(TimeSpan.FromSeconds(6));
        });

        PrintWelcomeBanner(port, bindAddress, settingsService, version);
        RunWithPortErrorHandling(app, port, bindAddress);
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
            var scriptPath = UpdateScriptGenerator.GenerateUpdateScript(extractedDir, UpdateService.GetCurrentBinaryPath(), update.Type);
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

    private static (int port, string bindAddress) ParseCommandLineArgs(string[] args)
    {
        var port = DefaultPort;
        var bindAddress = DefaultBindAddress;

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

        return (port, bindAddress);
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
            : new EmbeddedWebRootFileProvider(Assembly.GetExecutingAssembly(), "Ai.Tlbx.MidTerm");
#else
        IFileProvider fileProvider = new EmbeddedWebRootFileProvider(
            Assembly.GetExecutingAssembly(),
            "Ai.Tlbx.MidTerm");
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
        TtyHostSessionManager sessionManager,
        UpdateService updateService,
        SettingsService settingsService,
        string version)
    {
        var shellRegistry = app.Services.GetRequiredService<ShellRegistry>();

        app.MapGet("/api/version", () => Results.Text(version));

        app.MapGet("/api/health", () =>
        {
            var sessionCount = sessionManager.GetAllSessions().Count;

            string? conHostVersion = TtyHostSpawner.GetTtyHostVersion();
            var manifest = updateService.InstalledManifest;
            var conHostExpected = manifest.Pty;
            var conHostCompatible = conHostVersion == conHostExpected ||
                (conHostVersion is not null && manifest.MinCompatiblePty is not null &&
                 UpdateService.CompareVersions(conHostVersion, manifest.MinCompatiblePty) >= 0);

            var health = new SystemHealth
            {
                Healthy = true,
                Mode = "service",
                SessionCount = sessionCount,
                Version = version,
                WebProcessId = Environment.ProcessId,
                UptimeSeconds = (long)(DateTime.UtcNow - System.Diagnostics.Process.GetCurrentProcess().StartTime.ToUniversalTime()).TotalSeconds,
                Platform = OperatingSystem.IsWindows() ? "Windows" : OperatingSystem.IsMacOS() ? "macOS" : "Linux",
                TtyHostVersion = conHostVersion,
                TtyHostExpected = conHostExpected,
                TtyHostCompatible = conHostCompatible,
                WindowsBuildNumber = OperatingSystem.IsWindows() ? Environment.OSVersion.Version.Build : null
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

            var scriptPath = UpdateScriptGenerator.GenerateUpdateScript(extractedDir, UpdateService.GetCurrentBinaryPath(), update.Type);

            _ = Task.Run(async () =>
            {
                await Task.Delay(1000);
                UpdateScriptGenerator.ExecuteUpdateScript(scriptPath);
                Environment.Exit(0);
            });

            return Results.Ok("Update started. Server will restart shortly.");
        });

        app.MapGet("/api/update/result", () =>
        {
            var installDir = Path.GetDirectoryName(UpdateService.GetCurrentBinaryPath());
            if (string.IsNullOrEmpty(installDir))
            {
                return Results.Json(new UpdateResult { Found = false }, AppJsonContext.Default.UpdateResult);
            }

            var resultPath = Path.Combine(installDir, "update-result.json");
            if (!File.Exists(resultPath))
            {
                return Results.Json(new UpdateResult { Found = false }, AppJsonContext.Default.UpdateResult);
            }

            try
            {
                var json = File.ReadAllText(resultPath);
                var result = System.Text.Json.JsonSerializer.Deserialize<UpdateResult>(json, AppJsonContext.Default.UpdateResult);
                if (result is not null)
                {
                    result.Found = true;
                    return Results.Json(result, AppJsonContext.Default.UpdateResult);
                }
            }
            catch
            {
            }

            return Results.Json(new UpdateResult { Found = false }, AppJsonContext.Default.UpdateResult);
        });

        app.MapDelete("/api/update/result", () =>
        {
            var installDir = Path.GetDirectoryName(UpdateService.GetCurrentBinaryPath());
            if (string.IsNullOrEmpty(installDir))
            {
                return Results.Ok();
            }

            var resultPath = Path.Combine(installDir, "update-result.json");
            if (File.Exists(resultPath))
            {
                try { File.Delete(resultPath); } catch { }
            }

            return Results.Ok();
        });

        app.MapGet("/api/networks", () =>
        {
            static bool IsPhysicalOrVpn(string name)
            {
                // Always include VPN/Tailscale adapters
                if (name.Contains("Tailscale", StringComparison.OrdinalIgnoreCase) ||
                    name.Contains("VPN", StringComparison.OrdinalIgnoreCase))
                    return true;

                // Exclude known virtual adapters
                if (name.Contains("VMware", StringComparison.OrdinalIgnoreCase) ||
                    name.StartsWith("vEthernet", StringComparison.OrdinalIgnoreCase) ||
                    name.Contains("VirtualBox", StringComparison.OrdinalIgnoreCase) ||
                    name.Contains("Hyper-V", StringComparison.OrdinalIgnoreCase))
                    return false;

                return true;
            }

            var interfaces = System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces()
                .Where(ni => ni.OperationalStatus == System.Net.NetworkInformation.OperationalStatus.Up
                             && ni.NetworkInterfaceType != System.Net.NetworkInformation.NetworkInterfaceType.Loopback
                             && IsPhysicalOrVpn(ni.Name))
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
            return Results.Json(settings, AppJsonContext.Default.MidTermSettings);
        });

        app.MapPut("/api/settings", (MidTermSettings settings) =>
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
        TtyHostSessionManager sessionManager,
        TtyHostMuxConnectionManager muxManager,
        UpdateService updateService)
    {
        var muxHandler = new MuxWebSocketHandler(sessionManager, muxManager);
        var stateHandler = new StateWebSocketHandler(sessionManager, updateService);

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

    private static void PrintWelcomeBanner(int port, string bindAddress, SettingsService settingsService, string version)
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
        Console.WriteLine("Service (subprocess per terminal)");
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
