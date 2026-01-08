using System.Reflection;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Shells;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Settings;
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
        var tempCleanupService = app.Services.GetRequiredService<TempCleanupService>();

        // Clean orphaned temp files from previous crashed instances
        tempCleanupService.CleanupOrphanedFiles();

        var settings = settingsService.Load();
        var logDirectory = LogPaths.GetLogDirectory(settingsService.IsRunningAsService);
        Log.Initialize("mt", logDirectory, settings.LogLevel);
        Log.Info(() => $"MidTerm server starting (LogLevel: {settings.LogLevel})");

        // Auth middleware must run BEFORE static files so unauthenticated users get redirected to login
        AuthEndpoints.ConfigureAuthMiddleware(app, settingsService, authService);
        ConfigureStaticFiles(app);

        // Session manager - always uses ConHost (spawned subprocess per terminal)
        var sessionManager = new TtyHostSessionManager(runAsUser: settings.RunAsUser);
        var muxManager = new TtyHostMuxConnectionManager(sessionManager);

        // Configure remaining endpoints
        AuthEndpoints.MapAuthEndpoints(app, settingsService, authService);
        MapSystemEndpoints(app, sessionManager, updateService, settingsService, version);
        SessionApiEndpoints.MapSessionEndpoints(app, sessionManager);
        MapWebSocketMiddleware(app, sessionManager, muxManager, updateService, logDirectory);

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
                    // Final cleanup of any remaining temp files
                    tempCleanupService.CleanupAllMidTermFiles();
                    Log.Shutdown();
                    instanceGuard.Dispose();
                }
            });
            cleanupTask.Wait(TimeSpan.FromSeconds(6));
        });

        PrintWelcomeBanner(port, bindAddress, settingsService, version);

        // Discover existing sessions after banner so logs appear cleanly
        await sessionManager.DiscoverExistingSessionsAsync();

        RunWithPortErrorHandling(app, port, bindAddress, settings);
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

        // Load settings early for HTTPS configuration
        var settingsService = new SettingsService();
        var settings = settingsService.Load();

        builder.WebHost.ConfigureKestrel(options =>
        {
            options.AddServerHeader = false;

            // Configure HTTPS if enabled and certificate exists
            if (settings.UseHttps &&
                !string.IsNullOrEmpty(settings.CertificatePath) &&
                File.Exists(settings.CertificatePath))
            {
                try
                {
                    var cert = System.Security.Cryptography.X509Certificates.X509CertificateLoader.LoadPkcs12FromFile(
                        settings.CertificatePath,
                        settings.CertificatePassword);
                    options.ConfigureHttpsDefaults(httpsOptions =>
                    {
                        httpsOptions.ServerCertificate = cert;
                    });
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"Warning: Failed to load HTTPS certificate: {ex.Message}");
                    Console.WriteLine("Falling back to HTTP");
                }
            }
        });
        builder.Logging.SetMinimumLevel(Microsoft.Extensions.Logging.LogLevel.Warning);

        builder.Services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
        });

        builder.Services.AddSingleton<ShellRegistry>();
        builder.Services.AddSingleton<SettingsService>();
        builder.Services.AddSingleton<UpdateService>();
        builder.Services.AddSingleton<AuthService>();
        builder.Services.AddSingleton<TempCleanupService>();

        return builder;
    }

    private static string GetVersion()
    {
        var version = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "1.0.0";

        // Strip git hash suffix (e.g., "5.3.5+abc123" -> "5.3.5")
        var plusIndex = version.IndexOf('+');
        return plusIndex > 0 ? version[..plusIndex] : version;
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

        app.MapGet("/api/version", () =>
        {
            var displayVersion = UpdateService.IsDevEnvironment ? $"{version} (DEV)" : version;
            return Results.Text(displayVersion);
        });

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

        app.MapPost("/api/update/apply", async (string? source) =>
        {
            string? extractedDir;
            UpdateType updateType;

            bool deleteSourceAfter = true;

            if (source == "local")
            {
                // Apply local update (dev environment only)
                extractedDir = updateService.GetLocalUpdatePath();
                if (string.IsNullOrEmpty(extractedDir))
                {
                    return Results.BadRequest("No local update available");
                }

                var update = updateService.LatestUpdate;
                updateType = update?.LocalUpdate?.Type ?? UpdateType.Full;
                deleteSourceAfter = false; // Don't delete the local release folder
            }
            else
            {
                // Apply GitHub update (existing behavior)
                var update = updateService.LatestUpdate;
                if (update is null || !update.Available)
                {
                    return Results.BadRequest("No update available");
                }

                extractedDir = await updateService.DownloadUpdateAsync();
                if (string.IsNullOrEmpty(extractedDir))
                {
                    return Results.Problem("Failed to download update");
                }

                updateType = update.Type;
            }

            var scriptPath = UpdateScriptGenerator.GenerateUpdateScript(extractedDir, UpdateService.GetCurrentBinaryPath(), updateType, deleteSourceAfter);

            _ = Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(1000);
                    UpdateScriptGenerator.ExecuteUpdateScript(scriptPath);
                    Environment.Exit(0);
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"Update execution failed: {ex.Message}");
                }
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
        UpdateService updateService,
        string logDirectory)
    {
        var muxHandler = new MuxWebSocketHandler(sessionManager, muxManager);
        var stateHandler = new StateWebSocketHandler(sessionManager, updateService);
        var logFileWatcher = new LogFileWatcher(logDirectory, TimeSpan.FromMilliseconds(250));
        var logHandler = new LogWebSocketHandler(logFileWatcher, sessionManager);

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

            if (path == "/ws/logs")
            {
                await logHandler.HandleAsync(context);
                return;
            }

            context.Response.StatusCode = 404;
        });
    }

    private static void RunWithPortErrorHandling(WebApplication app, int port, string bindAddress, MidTermSettings settings)
    {
        try
        {
            var useHttps = settings.UseHttps &&
                           !string.IsNullOrEmpty(settings.CertificatePath) &&
                           File.Exists(settings.CertificatePath);

            var protocol = useHttps ? "https" : "http";
            app.Run($"{protocol}://{bindAddress}:{port}");
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

        Console.WriteLine();

        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine(@"            //   \\");
        Console.WriteLine(@"           //     \\         __  __ _     _ _____");
        Console.WriteLine(@"          //       \\       |  \/  (_) __| |_   _|__ _ __ _ __ ___");
        Console.Write(@"         //  ( ");
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.Write("·");
        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine(@" )  \\      | |\/| | |/ _` | | |/ _ \ '__| '_ ` _ \");
        Console.WriteLine(@"        //           \\     | |  | | | (_| | | |  __/ |  | | | | | |");
        Console.WriteLine(@"       //             \\    |_|  |_|_|\__,_| |_|\___|_|  |_| |_| |_|");
        Console.Write(@"      //               \\   ");
        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine("by J. Schmidt - https://github.com/AiTlbx");

        Console.ResetColor();
        Console.WriteLine();

        var platform = OperatingSystem.IsWindows() ? "Windows"
            : OperatingSystem.IsMacOS() ? "macOS"
            : OperatingSystem.IsLinux() ? "Linux"
            : "Unknown";

        Console.Write($"  Version:  {version}");
        if (UpdateService.IsDevEnvironment)
        {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.Write(" (DEV)");
            Console.ResetColor();
        }
        Console.WriteLine();
        Console.WriteLine($"  Platform: {platform}");
        Console.WriteLine($"  Shell:    {settings.DefaultShell}");
        Console.Write($"  Mode:     ");
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("Service (subprocess per terminal)");
        Console.ResetColor();
        Console.WriteLine();

        var useHttps = settings.UseHttps &&
                       !string.IsNullOrEmpty(settings.CertificatePath) &&
                       File.Exists(settings.CertificatePath);
        var protocol = useHttps ? "https" : "http";
        Console.WriteLine($"  Listening on {protocol}://{bindAddress}:{port}");
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

        // Security warning for network-exposed instances without authentication
        var isNetworkBound = bindAddress != "127.0.0.1" && bindAddress != "localhost";
        var hasNoPassword = string.IsNullOrEmpty(settings.PasswordHash) || !settings.AuthenticationEnabled;
        if (isNetworkBound && hasNoPassword)
        {
            Console.WriteLine();
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine("  WARNING: Listening on network interface without authentication!");
            Console.WriteLine("           Set a password in settings to secure access.");
            Console.ResetColor();
        }

        Console.WriteLine();
    }
}
