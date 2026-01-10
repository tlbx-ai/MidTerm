using System.Reflection;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Shells;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
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
        var certInfoService = app.Services.GetRequiredService<CertificateInfoService>();

        // Set certificate info (captured during ConfigureKestrel)
        if (_loadedCertificate is not null)
        {
            certInfoService.SetCertificate(_loadedCertificate, _isFallbackCertificate);
        }

        // Clean orphaned temp files from previous crashed instances
        tempCleanupService.CleanupOrphanedFiles();

        var settings = settingsService.Load();
        var logDirectory = LogPaths.GetLogDirectory(settingsService.IsRunningAsService);
        Log.Initialize("mt", logDirectory, settings.LogLevel);
        Log.Info(() => $"MidTerm server starting (LogLevel: {settings.LogLevel})");

        // Log startup status for diagnostics
        LogStartupStatus(settingsService, settings, port, bindAddress);

        // HSTS middleware - always enabled (HTTPS only)
        app.Use(async (context, next) =>
        {
            context.Response.Headers.StrictTransportSecurity = "max-age=31536000; includeSubDomains";
            await next();
        });

        // Auth middleware must run BEFORE static files so unauthenticated users get redirected to login
        AuthEndpoints.ConfigureAuthMiddleware(app, settingsService, authService);

        // Security headers middleware
        app.Use(async (context, next) =>
        {
            var headers = context.Response.Headers;
            headers["X-Frame-Options"] = "DENY";
            headers["X-Content-Type-Options"] = "nosniff";
            headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
            await next();
        });

        ConfigureStaticFiles(app);

        // Session manager - always uses ConHost (spawned subprocess per terminal)
        var sessionManager = new TtyHostSessionManager(runAsUser: settings.RunAsUser);
        var muxManager = new TtyHostMuxConnectionManager(sessionManager);

        // Listen for runAsUser settings changes (affects new terminals only)
        settingsService.AddSettingsListener(newSettings =>
        {
            var (isValid, _) = UserValidationService.ValidateRunAsUser(newSettings.RunAsUser);
            if (isValid)
            {
                sessionManager.UpdateRunAsUser(newSettings.RunAsUser);
            }
            else
            {
                Console.WriteLine($"[Settings] Ignoring invalid RunAsUser from file: {newSettings.RunAsUser}");
            }
        });

        // Configure remaining endpoints
        AuthEndpoints.MapAuthEndpoints(app, settingsService, authService);
        MapSystemEndpoints(app, sessionManager, updateService, settingsService, version);
        SessionApiEndpoints.MapSessionEndpoints(app, sessionManager);
        MapWebSocketMiddleware(app, sessionManager, muxManager, updateService, settingsService, authService, logDirectory);

        // Register cleanup for graceful shutdown (service restart, Ctrl+C)
        var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();

        // Log successful startup when server is fully operational
        lifetime.ApplicationStarted.Register(() =>
        {
            Log.Info(() => $"Server fully operational - listening on https://{bindAddress}:{port}");
        });

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

        if (args.Contains("--help") || args.Contains("-h"))
        {
            PrintHelp();
            return true;
        }

        if (args.Contains("--hash-password"))
        {
            string password;
            if (Console.IsInputRedirected)
            {
                // Secure: read password from stdin (piped input)
                password = Console.ReadLine() ?? "";
            }
            else
            {
                // Interactive: prompt for password
                Console.Error.Write("Enter password: ");
                password = ReadPasswordMasked();
            }

            if (string.IsNullOrEmpty(password))
            {
                Console.Error.WriteLine("Error: Password cannot be empty");
                Environment.Exit(1);
            }

            var authService = new AuthService(new SettingsService());
            Console.WriteLine(authService.HashPassword(password));
            return true;
        }

        var writeSecretIdx = Array.IndexOf(args, "--write-secret");
        if (writeSecretIdx >= 0)
        {
            if (writeSecretIdx + 1 >= args.Length)
            {
                Console.Error.WriteLine("Error: --write-secret requires a key name");
                Console.Error.WriteLine("Usage: mt --write-secret <key> [--service-mode]");
                Console.Error.WriteLine("Keys: password_hash, session_secret, certificate_password");
                Environment.Exit(1);
            }

            var keyArg = args[writeSecretIdx + 1];
            var secretKey = keyArg switch
            {
                "password_hash" => SecretKeys.PasswordHash,
                "session_secret" => SecretKeys.SessionSecret,
                "certificate_password" => SecretKeys.CertificatePassword,
                _ => null
            };

            if (secretKey is null)
            {
                Console.Error.WriteLine($"Error: Unknown secret key '{keyArg}'");
                Console.Error.WriteLine("Valid keys: password_hash, session_secret, certificate_password");
                Environment.Exit(1);
            }

            string value;
            if (Console.IsInputRedirected)
            {
                value = Console.ReadLine() ?? "";
            }
            else
            {
                Console.Error.Write($"Enter {keyArg}: ");
                value = ReadPasswordMasked();
            }

            if (string.IsNullOrEmpty(value))
            {
                Console.Error.WriteLine("Error: Value cannot be empty");
                Environment.Exit(1);
            }

            // If --service-mode is specified, use service directory regardless of detection
            var serviceMode = args.Contains("--service-mode");
            ISecretStorage secretStorage;
            if (serviceMode)
            {
                string settingsDir;
                if (OperatingSystem.IsWindows())
                {
                    var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
                    settingsDir = Path.Combine(programData, "MidTerm");
                }
                else
                {
                    settingsDir = "/usr/local/etc/midterm";
                }
                secretStorage = SecretStorageFactory.Create(settingsDir, isServiceMode: true);
            }
            else
            {
                var settingsService = new SettingsService();
                secretStorage = settingsService.SecretStorage;
            }

            secretStorage.SetSecret(secretKey, value);
            Console.WriteLine($"Secret '{keyArg}' stored successfully");
            return true;
        }

        if (args.Contains("--generate-cert"))
        {
            var force = args.Contains("--force");
            var serviceMode = args.Contains("--service-mode");
            GenerateCertificateCommand(force, serviceMode);
            return true;
        }

        return false;
    }

    private static void PrintHelp()
    {
        Console.WriteLine($"MidTerm {GetVersion()} - Web-based Terminal Multiplexer");
        Console.WriteLine();
        Console.WriteLine("Usage: mt [options]");
        Console.WriteLine();
        Console.WriteLine("Options:");
        Console.WriteLine("  --port <port>       Set listening port (default: 2000)");
        Console.WriteLine("  --bind <address>    Set bind address (default: 0.0.0.0)");
        Console.WriteLine("  --version, -v       Show version");
        Console.WriteLine("  --help, -h          Show this help");
        Console.WriteLine("  --hash-password     Hash a password (reads from stdin)");
        Console.WriteLine("  --write-secret <k>  Store secret (reads value from stdin)");
        Console.WriteLine("                      Keys: password_hash, session_secret, certificate_password");
        Console.WriteLine("  --generate-cert     Generate HTTPS certificate (add --service-mode for service install)");
        Console.WriteLine("  --apply-update      Download and apply latest update");
        Console.WriteLine();
        Console.WriteLine("Password Recovery:");
        Console.WriteLine("  If you forget your password:");
        Console.WriteLine("  1. Stop the MidTerm service");
        Console.WriteLine("  2. Edit settings.json (location shown on startup)");
        Console.WriteLine("  3. Set \"authenticationEnabled\" to false");
        Console.WriteLine("  4. Restart MidTerm");
        Console.WriteLine("  5. Set new password in Settings > Security");
        Console.WriteLine();
        Console.WriteLine("Settings locations:");
        Console.WriteLine("  Service: %ProgramData%\\MidTerm\\settings.json (Windows)");
        Console.WriteLine("           /usr/local/etc/midterm/settings.json (Unix)");
        Console.WriteLine("  User:    ~/.midterm/settings.json");
    }

    private static string ReadPasswordMasked()
    {
        var password = new System.Text.StringBuilder();
        while (true)
        {
            var key = Console.ReadKey(intercept: true);
            if (key.Key == ConsoleKey.Enter)
            {
                Console.Error.WriteLine();
                break;
            }
            if (key.Key == ConsoleKey.Backspace && password.Length > 0)
            {
                password.Length--;
                Console.Error.Write("\b \b");
            }
            else if (!char.IsControl(key.KeyChar))
            {
                password.Append(key.KeyChar);
                Console.Error.Write('*');
            }
        }
        return password.ToString();
    }

    private static void GenerateCertificateCommand(bool force, bool serviceMode)
    {
        var settingsService = new SettingsService();
        var settings = settingsService.Load();

        // If serviceMode is explicitly requested, use service directory regardless of detection
        string settingsDir;
        if (serviceMode)
        {
            if (OperatingSystem.IsWindows())
            {
                var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
                settingsDir = Path.Combine(programData, "MidTerm");
            }
            else
            {
                settingsDir = "/usr/local/etc/midterm";
            }
            Directory.CreateDirectory(settingsDir);
        }
        else
        {
            settingsDir = Path.GetDirectoryName(settingsService.SettingsPath) ?? ".";
        }

        var certPath = Path.Combine(settingsDir, "midterm.pem");
        var keyId = "midterm";

        if (File.Exists(certPath) && !force)
        {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine("Certificate already exists. Use --force to regenerate.");
            Console.ResetColor();
            Console.WriteLine($"  Path: {certPath}");
            return;
        }

        Console.WriteLine("Generating self-signed certificate...");

        var dnsNames = CertificateGenerator.GetDnsNames();
        var ipAddresses = CertificateGenerator.GetLocalIPAddresses();

        Console.WriteLine($"  DNS names: {string.Join(", ", dnsNames)}");
        Console.WriteLine($"  IP addresses: {string.Join(", ", ipAddresses)}");

        var cert = CertificateGenerator.GenerateSelfSigned(dnsNames, ipAddresses, useEcdsa: true);

        // Export public certificate as PEM
        CertificateGenerator.ExportPublicCertToPem(cert, certPath);

        // Store private key with OS-level protection
        var isService = serviceMode || settingsService.IsRunningAsService;
        var protector = Services.Security.CertificateProtectorFactory.Create(settingsDir, isService);
        var privateKeyBytes = cert.GetECDsaPrivateKey()?.ExportPkcs8PrivateKey()
                              ?? cert.GetRSAPrivateKey()?.ExportPkcs8PrivateKey()
                              ?? throw new InvalidOperationException("Failed to export private key");
        protector.StorePrivateKey(privateKeyBytes, keyId);
        System.Security.Cryptography.CryptographicOperations.ZeroMemory(privateKeyBytes);

        // Update settings
        settings.CertificatePath = certPath;
        settings.CertificatePassword = null;
        settings.KeyProtection = KeyProtectionMethod.OsProtected;
        settingsService.Save(settings);

        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine("Certificate generated successfully!");
        Console.ResetColor();

        CertificateGenerator.PrintTrustInstructions(certPath, dnsNames, ipAddresses);
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

    private static X509Certificate2? _loadedCertificate;
    private static bool _isFallbackCertificate;

    private static WebApplicationBuilder CreateBuilder(string[] args)
    {
        var builder = WebApplication.CreateSlimBuilder(args);

#if WINDOWS
        builder.Host.UseWindowsService();
#endif

        // Load settings early for HTTPS configuration
        var settingsService = new SettingsService();
        var settings = settingsService.Load();

        // .NET 10 requires this for dynamic https:// URLs in app.Run()
        builder.WebHost.UseKestrelHttpsConfiguration();

        builder.WebHost.ConfigureKestrel(options =>
        {
            options.AddServerHeader = false;

            // Always HTTPS - no HTTP endpoint
            var cert = LoadOrGenerateCertificate(settings, settingsService);
            if (cert is null)
            {
                // Fallback: generate emergency in-memory certificate so users can access settings
                Console.ForegroundColor = ConsoleColor.Yellow;
                Console.WriteLine("Warning: Using emergency fallback certificate.");
                Console.WriteLine("         Run 'mt --generate-cert' to create a proper certificate.");
                Console.ResetColor();
                cert = CertificateGenerator.GenerateSelfSigned(["localhost"], ["127.0.0.1"], useEcdsa: true);
                _isFallbackCertificate = true;
            }

            _loadedCertificate = cert;

            options.ConfigureHttpsDefaults(httpsOptions =>
            {
                httpsOptions.ServerCertificate = cert;

                // TLS 1.2 and 1.3 only (TLS 1.0/1.1 caps SSL Labs to B grade)
                httpsOptions.SslProtocols = System.Security.Authentication.SslProtocols.Tls12
                                            | System.Security.Authentication.SslProtocols.Tls13;

                // Cipher suites for SSL Labs A+ rating (Linux/macOS only, Windows uses Schannel)
                if (!OperatingSystem.IsWindows())
                {
                    httpsOptions.OnAuthenticate = (context, sslOptions) =>
                    {
#pragma warning disable CA1416 // Validate platform compatibility (guarded by IsWindows check above)
                        sslOptions.CipherSuitesPolicy = new System.Net.Security.CipherSuitesPolicy(
                        [
                            // TLS 1.3 suites (AEAD only, forward secrecy built-in)
                            System.Net.Security.TlsCipherSuite.TLS_AES_256_GCM_SHA384,
                            System.Net.Security.TlsCipherSuite.TLS_AES_128_GCM_SHA256,
                            System.Net.Security.TlsCipherSuite.TLS_CHACHA20_POLY1305_SHA256,

                            // TLS 1.2 suites (ECDHE for forward secrecy, AEAD modes)
                            System.Net.Security.TlsCipherSuite.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
                            System.Net.Security.TlsCipherSuite.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
                            System.Net.Security.TlsCipherSuite.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
                            System.Net.Security.TlsCipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
                            System.Net.Security.TlsCipherSuite.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
                            System.Net.Security.TlsCipherSuite.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
                        ]);
#pragma warning restore CA1416
                    };
                }
            });
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
        builder.Services.AddSingleton<CertificateInfoService>();

        return builder;
    }

    private static System.Security.Cryptography.X509Certificates.X509Certificate2? LoadOrGenerateCertificate(
        MidTermSettings settings,
        SettingsService settingsService)
    {
        var settingsDir = Path.GetDirectoryName(settingsService.SettingsPath) ?? ".";
        const string keyId = "midterm";

        // Try to load existing certificate
        if (!string.IsNullOrEmpty(settings.CertificatePath) && File.Exists(settings.CertificatePath))
        {
            try
            {
                // Check if using OS-protected key or legacy PFX
                if (settings.KeyProtection == KeyProtectionMethod.OsProtected)
                {
                    var protector = Services.Security.CertificateProtectorFactory.Create(settingsDir, settingsService.IsRunningAsService);
                    return protector.LoadCertificateWithPrivateKey(settings.CertificatePath, keyId);
                }
                else
                {
                    // Legacy PFX loading
                    return System.Security.Cryptography.X509Certificates.X509CertificateLoader.LoadPkcs12FromFile(
                        settings.CertificatePath,
                        settings.CertificatePassword);
                }
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine($"Error: Failed to load HTTPS certificate: {ex.Message}");
                Console.ResetColor();
                return null;
            }
        }

        // Auto-generate certificate if none exists
        Console.WriteLine("  No certificate found. Generating self-signed certificate...");

        try
        {
            var certPath = Path.Combine(settingsDir, "midterm.pem");
            var dnsNames = CertificateGenerator.GetDnsNames();
            var ipAddresses = CertificateGenerator.GetLocalIPAddresses();

            var cert = CertificateGenerator.GenerateSelfSigned(dnsNames, ipAddresses, useEcdsa: true);

            // Export public certificate as PEM
            CertificateGenerator.ExportPublicCertToPem(cert, certPath);

            // Store private key with OS-level protection
            var protector = Services.Security.CertificateProtectorFactory.Create(settingsDir, settingsService.IsRunningAsService);
            var privateKeyBytes = cert.GetECDsaPrivateKey()?.ExportPkcs8PrivateKey()
                                  ?? cert.GetRSAPrivateKey()?.ExportPkcs8PrivateKey()
                                  ?? throw new InvalidOperationException("Failed to export private key");
            protector.StorePrivateKey(privateKeyBytes, keyId);
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(privateKeyBytes);

            // Update settings with new certificate path
            settings.CertificatePath = certPath;
            settings.CertificatePassword = null;
            settings.KeyProtection = KeyProtectionMethod.OsProtected;
            settingsService.Save(settings);

            CertificateGenerator.PrintTrustInstructions(certPath, dnsNames, ipAddresses);

            // Reload certificate with private key from protected storage
            return protector.LoadCertificateWithPrivateKey(certPath, keyId);
        }
        catch (Exception ex)
        {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: Failed to generate HTTPS certificate: {ex.Message}");
            Console.ResetColor();
            return null;
        }
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

        app.MapGet("/api/certificate/info", () =>
        {
            var certService = app.Services.GetRequiredService<CertificateInfoService>();
            return Results.Json(certService.GetInfo(), AppJsonContext.Default.CertificateInfoResponse);
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
            var publicSettings = MidTermSettingsPublic.FromSettings(settings);
            return Results.Json(publicSettings, AppJsonContext.Default.MidTermSettingsPublic);
        });

        app.MapPut("/api/settings", (MidTermSettingsPublic publicSettings) =>
        {
            try
            {
                var currentSettings = settingsService.Load();
                publicSettings.ApplyTo(currentSettings);
                settingsService.Save(currentSettings);
                return Results.Ok();
            }
            catch (ArgumentException ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
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
        SettingsService settingsService,
        AuthService authService,
        string logDirectory)
    {
        var muxHandler = new MuxWebSocketHandler(sessionManager, muxManager, settingsService, authService);
        var stateHandler = new StateWebSocketHandler(sessionManager, updateService, settingsService, authService);
        var settingsHandler = new SettingsWebSocketHandler(settingsService, authService);
        var logFileWatcher = new LogFileWatcher(logDirectory, TimeSpan.FromMilliseconds(250));
        var logHandler = new LogWebSocketHandler(logFileWatcher, sessionManager, settingsService, authService);

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

            if (path == "/ws/settings")
            {
                await settingsHandler.HandleAsync(context);
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

    private static void RunWithPortErrorHandling(WebApplication app, int port, string bindAddress)
    {
        try
        {
            // Always HTTPS - no HTTP endpoint
            app.Run($"https://{bindAddress}:{port}");
        }
        catch (IOException ex) when (ex.InnerException is System.Net.Sockets.SocketException socketEx &&
            socketEx.SocketErrorCode == System.Net.Sockets.SocketError.AddressAlreadyInUse)
        {
            Log.Error(() => $"Port {port} is already in use. Exiting.");

            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"  Error: Port {port} is already in use by another process.");
            Console.ResetColor();
            Console.WriteLine();
            Console.WriteLine($"  Try one of the following:");
            Console.WriteLine($"    - Close the application using port {port}");
            Console.WriteLine($"    - Use a different port: mt --port 2001");
            Console.WriteLine();
            Environment.Exit(1);
        }
    }

    private static void LogStartupStatus(SettingsService settingsService, MidTermSettings settings, int port, string bindAddress)
    {
        // Log settings status
        var settingsStatus = settingsService.LoadStatus switch
        {
            SettingsLoadStatus.LoadedFromFile => $"loaded from {settingsService.SettingsPath}",
            SettingsLoadStatus.MigratedFromOld => $"migrated from {settingsService.SettingsPath}.old",
            SettingsLoadStatus.ErrorFallbackToDefault => $"ERROR loading {settingsService.SettingsPath}: {settingsService.LoadError}",
            _ => "using defaults (no settings file)"
        };
        Log.Info(() => $"Settings: {settingsStatus}");

        // Log mode
        Log.Info(() => $"Mode: {(settingsService.IsRunningAsService ? "Service" : "User")}");

        // Log password/auth status
        var hasPassword = !string.IsNullOrEmpty(settings.PasswordHash);
        var authEnabled = settings.AuthenticationEnabled;
        if (hasPassword && authEnabled)
        {
            Log.Info(() => "Authentication: enabled (password configured)");
        }
        else if (hasPassword && !authEnabled)
        {
            Log.Warn(() => "Authentication: DISABLED (password exists but auth is disabled)");
        }
        else if (!hasPassword && authEnabled)
        {
            Log.Warn(() => "Authentication: MISCONFIGURED (auth enabled but no password set)");
        }
        else
        {
            var isNetworkBound = bindAddress != "127.0.0.1" && bindAddress != "localhost";
            if (isNetworkBound)
            {
                Log.Warn(() => "Authentication: DISABLED - server exposed on network without password!");
            }
            else
            {
                Log.Info(() => "Authentication: disabled (localhost only)");
            }
        }

        // Log certificate status
        if (_loadedCertificate is not null)
        {
            if (_isFallbackCertificate)
            {
                Log.Warn(() => "Certificate: using emergency fallback (in-memory generated)");
            }
            else
            {
                var certPath = settings.CertificatePath ?? "unknown";
                var keyProtection = settings.KeyProtection == KeyProtectionMethod.OsProtected ? "OS-protected" : "legacy PFX";
                Log.Info(() => $"Certificate: loaded from {certPath} ({keyProtection})");
            }
        }
        else
        {
            Log.Error(() => "Certificate: FAILED to load - HTTPS will not work!");
        }

        // Log binding
        Log.Info(() => $"Binding: https://{bindAddress}:{port}");
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

        // Always HTTPS
        Console.WriteLine($"  Listening on https://{bindAddress}:{port}");
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
