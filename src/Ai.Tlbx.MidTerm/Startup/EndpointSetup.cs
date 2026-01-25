using System.Net.NetworkInformation;
using System.Net.Sockets;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Shells;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Startup;

public static class EndpointSetup
{
    public static void MapBootstrapEndpoints(
        WebApplication app,
        TtyHostSessionManager sessionManager,
        UpdateService updateService,
        SettingsService settingsService,
        string version)
    {
        var shellRegistry = app.Services.GetRequiredService<ShellRegistry>();

        app.MapGet("/api/bootstrap", () =>
        {
            var settings = settingsService.Load();
            var publicSettings = MidTermSettingsPublic.FromSettings(settings);

            var authStatus = new AuthStatusResponse
            {
                AuthenticationEnabled = settings.AuthenticationEnabled,
                PasswordSet = !string.IsNullOrEmpty(settings.PasswordHash)
            };

            var conHostVersion = TtyHostSpawner.GetTtyHostVersion();
            var manifest = updateService.InstalledManifest;
            var conHostExpected = manifest.Pty;
            var conHostCompatible = conHostVersion == conHostExpected ||
                (conHostVersion is not null && manifest.MinCompatiblePty is not null &&
                 UpdateService.CompareVersions(conHostVersion, manifest.MinCompatiblePty) >= 0);

            var networks = GetNetworkInterfaces();
            var users = UserEnumerationService.GetSystemUsers();

            var shells = shellRegistry.GetPlatformShells().Select(s => new ShellInfoDto
            {
                Type = s.ShellType.ToString(),
                DisplayName = s.DisplayName,
                IsAvailable = s.IsAvailable(),
                SupportsOsc7 = s.SupportsOsc7
            }).ToList();

            var updateResult = ReadAndClearUpdateResult(settingsService.SettingsDirectory);
            var displayVersion = UpdateService.IsDevEnvironment ? $"{version} (DEV)" : version;

            var features = new FeatureFlags
            {
                VoiceChat = UpdateService.IsDevEnvironment
            };

            var response = new BootstrapResponse
            {
                Auth = authStatus,
                Version = displayVersion,
                TtyHostVersion = conHostVersion,
                TtyHostCompatible = conHostCompatible,
                UptimeSeconds = (long)(DateTime.UtcNow - System.Diagnostics.Process.GetCurrentProcess().StartTime.ToUniversalTime()).TotalSeconds,
                Platform = OperatingSystem.IsWindows() ? "Windows" : OperatingSystem.IsMacOS() ? "macOS" : "Linux",
                Hostname = Environment.MachineName,
                Settings = publicSettings,
                Networks = networks,
                Users = users,
                Shells = shells,
                UpdateResult = updateResult,
                DevMode = UpdateService.IsDevEnvironment,
                Features = features,
                VoicePassword = UpdateService.IsDevEnvironment ? settings.VoiceServerPassword : null
            };

            return Results.Json(response, AppJsonContext.Default.BootstrapResponse);
        });

        app.MapGet("/api/bootstrap/login", () =>
        {
            var certService = app.Services.GetRequiredService<CertificateInfoService>();
            var certInfo = certService.GetInfo();

            var response = new BootstrapLoginResponse
            {
                Certificate = certInfo
            };

            return Results.Json(response, AppJsonContext.Default.BootstrapLoginResponse);
        });
    }

    private static List<NetworkInterfaceDto> GetNetworkInterfaces()
    {
        static bool IsPhysicalOrVpn(string name)
        {
            if (name.Contains("Tailscale", StringComparison.OrdinalIgnoreCase) ||
                name.Contains("VPN", StringComparison.OrdinalIgnoreCase))
                return true;

            if (name.Contains("VMware", StringComparison.OrdinalIgnoreCase) ||
                name.StartsWith("vEthernet", StringComparison.OrdinalIgnoreCase) ||
                name.Contains("VirtualBox", StringComparison.OrdinalIgnoreCase) ||
                name.Contains("Hyper-V", StringComparison.OrdinalIgnoreCase))
                return false;

            return true;
        }

        return NetworkInterface.GetAllNetworkInterfaces()
            .Where(ni => ni.OperationalStatus == OperationalStatus.Up
                         && ni.NetworkInterfaceType != NetworkInterfaceType.Loopback
                         && IsPhysicalOrVpn(ni.Name))
            .SelectMany(ni => ni.GetIPProperties().UnicastAddresses
                .Where(addr => addr.Address.AddressFamily == AddressFamily.InterNetwork)
                .Select(addr => new NetworkInterfaceDto
                {
                    Name = ni.Name,
                    Ip = addr.Address.ToString()
                }))
            .Prepend(new NetworkInterfaceDto { Name = "Localhost", Ip = "localhost" })
            .ToList();
    }

    private static UpdateResult? ReadAndClearUpdateResult(string settingsDirectory)
    {
        // Update result is written to settings directory (not install directory!)
        // Windows: C:\ProgramData\MidTerm\update-result.json
        // Unix: /usr/local/etc/midterm/update-result.json or ~/.midterm/update-result.json
        var resultPath = Path.Combine(settingsDirectory, "update-result.json");
        if (!File.Exists(resultPath))
        {
            return null;
        }

        try
        {
            var json = File.ReadAllText(resultPath);
            var result = System.Text.Json.JsonSerializer.Deserialize<UpdateResult>(json, AppJsonContext.Default.UpdateResult);
            if (result is not null)
            {
                result.Found = true;
                try { File.Delete(resultPath); } catch { }
                return result;
            }
        }
        catch
        {
        }

        return null;
    }

    public static void MapSystemEndpoints(
        WebApplication app,
        TtyHostSessionManager sessionManager,
        UpdateService updateService,
        SettingsService settingsService,
        string version,
        IHostApplicationLifetime? lifetime = null)
    {
        var shellRegistry = app.Services.GetRequiredService<ShellRegistry>();

        // Shutdown endpoint for tray helper (localhost only for security)
        if (lifetime is not null)
        {
            app.MapPost("/api/shutdown", (HttpContext context) =>
            {
                var remoteIp = context.Connection.RemoteIpAddress;
                var isLocalhost = remoteIp is not null &&
                    (System.Net.IPAddress.IsLoopback(remoteIp) ||
                     remoteIp.Equals(System.Net.IPAddress.IPv6Loopback) ||
                     remoteIp.ToString() == "::ffff:127.0.0.1");

                if (!isLocalhost)
                {
                    Log.Warn(() => $"Shutdown request rejected from non-localhost IP: {remoteIp}");
                    return Results.Forbid();
                }

                Log.Info(() => "Shutdown requested via API (localhost)");
                lifetime.StopApplication();
                return Results.Ok("Shutdown initiated");
            });
        }

        // Consolidated system endpoint (replaces /api/version, /api/health, /api/version/details)
        app.MapGet("/api/system", () =>
        {
            var sessionCount = sessionManager.GetAllSessions().Count;
            var manifest = updateService.InstalledManifest;

            string? conHostVersion = TtyHostSpawner.GetTtyHostVersion();
            var conHostExpected = manifest.Pty;
            var conHostCompatible = conHostVersion == conHostExpected ||
                (conHostVersion is not null && manifest.MinCompatiblePty is not null &&
                 UpdateService.CompareVersions(conHostVersion, manifest.MinCompatiblePty) >= 0);

            var displayVersion = UpdateService.IsDevEnvironment ? $"{version} (DEV)" : version;

            var response = new SystemResponse
            {
                Healthy = true,
                Version = displayVersion,
                Manifest = manifest,
                SessionCount = sessionCount,
                UptimeSeconds = (long)(DateTime.UtcNow - System.Diagnostics.Process.GetCurrentProcess().StartTime.ToUniversalTime()).TotalSeconds,
                Platform = OperatingSystem.IsWindows() ? "Windows" : OperatingSystem.IsMacOS() ? "macOS" : "Linux",
                TtyHost = new TtyHostInfo
                {
                    Version = conHostVersion,
                    Expected = conHostExpected,
                    Compatible = conHostCompatible
                },
                WebProcessId = Environment.ProcessId,
                WindowsBuildNumber = OperatingSystem.IsWindows() ? Environment.OSVersion.Version.Build : null
            };
            return Results.Json(response, AppJsonContext.Default.SystemResponse);
        });

        // Legacy endpoints kept for backward compatibility
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

        app.MapGet("/api/certificate/download/pem", () =>
        {
            var certService = app.Services.GetRequiredService<CertificateInfoService>();
            var pemBytes = certService.ExportPemBytes();
            if (pemBytes is null)
            {
                return Results.NotFound("Certificate not available");
            }
            return Results.File(pemBytes, "application/x-pem-file", "midterm.pem");
        });

        app.MapGet("/api/certificate/download/mobileconfig", (HttpContext context) =>
        {
            var certService = app.Services.GetRequiredService<CertificateInfoService>();
            var hostname = context.Request.Host.Host;
            var configBytes = certService.GenerateMobileConfig(hostname);
            if (configBytes is null)
            {
                return Results.NotFound("Certificate not available");
            }
            return Results.File(configBytes, "application/x-apple-aspen-config", "midterm.mobileconfig");
        });

        app.MapGet("/api/certificate/share-packet", (HttpContext context) =>
        {
            var certService = app.Services.GetRequiredService<CertificateInfoService>();
            var downloadInfo = certService.GetDownloadInfo();

            var hostPort = context.Request.Host.Port ?? 2000;

            var interfaces = System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces()
                .Where(ni => ni.OperationalStatus == System.Net.NetworkInformation.OperationalStatus.Up
                             && ni.NetworkInterfaceType != System.Net.NetworkInformation.NetworkInterfaceType.Loopback)
                .Where(ni => ni.Name.Contains("Tailscale", StringComparison.OrdinalIgnoreCase) ||
                             ni.Name.Contains("VPN", StringComparison.OrdinalIgnoreCase) ||
                             (!ni.Name.Contains("VMware", StringComparison.OrdinalIgnoreCase) &&
                              !ni.Name.StartsWith("vEthernet", StringComparison.OrdinalIgnoreCase) &&
                              !ni.Name.Contains("VirtualBox", StringComparison.OrdinalIgnoreCase) &&
                              !ni.Name.Contains("Hyper-V", StringComparison.OrdinalIgnoreCase)))
                .SelectMany(ni => ni.GetIPProperties().UnicastAddresses
                    .Where(addr => addr.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                    .Select(addr => new NetworkEndpointInfo
                    {
                        Name = ni.Name,
                        Url = $"https://{addr.Address}:{hostPort}"
                    }))
                .ToArray();
            var firstIp = interfaces.FirstOrDefault()?.Url.Split("://")[1].Split(":")[0] ?? "localhost";

            var sharePacket = new SharePacketInfo
            {
                Certificate = downloadInfo,
                Endpoints = interfaces,
                TrustPageUrl = $"https://{firstIp}:{hostPort}/trust",
                Port = hostPort
            };

            return Results.Json(sharePacket, AppJsonContext.Default.SharePacketInfo);
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
                extractedDir = updateService.GetLocalUpdatePath();
                if (string.IsNullOrEmpty(extractedDir))
                {
                    return Results.BadRequest("No local update available");
                }

                var update = updateService.LatestUpdate;
                updateType = update?.LocalUpdate?.Type ?? UpdateType.Full;
                deleteSourceAfter = false;
            }
            else
            {
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

            var scriptPath = UpdateScriptGenerator.GenerateUpdateScript(
                extractedDir,
                UpdateService.GetCurrentBinaryPath(),
                settingsService.SettingsDirectory,
                updateType,
                deleteSourceAfter);

            _ = Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(3000);
                    UpdateScriptGenerator.ExecuteUpdateScript(scriptPath);
                    Environment.Exit(0);
                }
                catch (Exception ex)
                {
                    Log.Error(() => $"Update execution failed: {ex.Message}");
                }
            });

            return Results.Ok("Update started. Server will restart shortly.");
        });

        // GET /api/update/result?clear=true - get update result and optionally clear it
        app.MapGet("/api/update/result", (bool clear = false) =>
        {
            // Update result is in settings directory, not install directory
            var resultPath = Path.Combine(settingsService.SettingsDirectory, "update-result.json");
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

                    // Clear the result file if requested
                    if (clear)
                    {
                        try { File.Delete(resultPath); } catch { }
                    }

                    return Results.Json(result, AppJsonContext.Default.UpdateResult);
                }
            }
            catch
            {
            }

            return Results.Json(new UpdateResult { Found = false }, AppJsonContext.Default.UpdateResult);
        });

        // Legacy DELETE endpoint kept for backward compatibility
        app.MapDelete("/api/update/result", () =>
        {
            // Update result is in settings directory, not install directory
            var resultPath = Path.Combine(settingsService.SettingsDirectory, "update-result.json");
            if (File.Exists(resultPath))
            {
                try { File.Delete(resultPath); } catch { }
            }

            return Results.Ok();
        });

        // GET /api/update/log - get the update log file content
        app.MapGet("/api/update/log", () =>
        {
            // Try settings directory first (user mode on all platforms)
            var logPath = Path.Combine(settingsService.SettingsDirectory, "update.log");

            // Unix service mode: log is in /usr/local/var/log/
            if (!File.Exists(logPath) && !OperatingSystem.IsWindows())
            {
                var svcPath = "/usr/local/var/log/update.log";
                if (File.Exists(svcPath))
                {
                    logPath = svcPath;
                }
            }

            if (!File.Exists(logPath))
            {
                return Results.NotFound("No update log found");
            }

            try
            {
                var content = File.ReadAllText(logPath);
                if (content.Length > 100_000)
                {
                    content = content[^100_000..];
                }
                return Results.Text(content, "text/plain");
            }
            catch (Exception ex)
            {
                return Results.Problem($"Failed to read log: {ex.Message}");
            }
        });

        app.MapGet("/api/networks", () =>
        {
            static bool IsPhysicalOrVpn(string name)
            {
                if (name.Contains("Tailscale", StringComparison.OrdinalIgnoreCase) ||
                    name.Contains("VPN", StringComparison.OrdinalIgnoreCase))
                    return true;

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
                .Prepend(new NetworkInterfaceDto { Name = "Localhost", Ip = "localhost" })
                .ToList();
            return Results.Json(interfaces, AppJsonContext.Default.ListNetworkInterfaceDto);
        });

        app.MapGet("/api/shells", () =>
        {
            var shells = shellRegistry.GetPlatformShells().Select(s => new ShellInfoDto
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
            var publicSettings = Settings.MidTermSettingsPublic.FromSettings(settings);
            return Results.Json(publicSettings, AppJsonContext.Default.MidTermSettingsPublic);
        });

        app.MapPut("/api/settings", (Settings.MidTermSettingsPublic publicSettings) =>
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

    public static void MapWebSocketMiddleware(
        WebApplication app,
        TtyHostSessionManager sessionManager,
        TtyHostMuxConnectionManager muxManager,
        UpdateService updateService,
        SettingsService settingsService,
        AuthService authService,
        ShutdownService shutdownService,
        string logDirectory)
    {
        var muxHandler = new MuxWebSocketHandler(sessionManager, muxManager, settingsService, authService, shutdownService);
        var stateHandler = new StateWebSocketHandler(sessionManager, updateService, settingsService, authService, shutdownService);
        var settingsHandler = new SettingsWebSocketHandler(settingsService, updateService, authService, shutdownService);

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

            context.Response.StatusCode = 404;
        });
    }
}
