using System.Diagnostics;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Settings;
using Ai.Tlbx.MidTerm.Startup;

namespace Ai.Tlbx.MidTerm;

public class Program
{
    private enum DiagLogLevel { Info, Warning, Error }

    private static void WriteEventLog(string message, DiagLogLevel level = DiagLogLevel.Info)
    {
#if WINDOWS
        if (OperatingSystem.IsWindows())
        {
            const string source = "MidTerm";
            const string logName = "Application";

            var eventLogType = level switch
            {
                DiagLogLevel.Warning => EventLogEntryType.Warning,
                DiagLogLevel.Error => EventLogEntryType.Error,
                _ => EventLogEntryType.Information
            };

            try
            {
                if (!EventLog.SourceExists(source))
                {
                    EventLog.CreateEventSource(source, logName);
                }

                EventLog.WriteEntry(source, message, eventLogType);
            }
            catch
            {
                try
                {
                    var isService = LogPaths.DetectWindowsServiceMode();
                    var logDir = LogPaths.GetLogDirectory(isService);
                    Directory.CreateDirectory(logDir);
                    var logPath = Path.Combine(logDir, "startup-debug.log");
                    File.AppendAllText(logPath, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}] [{level}] {message}{Environment.NewLine}");
                }
                catch
                {
                }
            }
        }
#endif
    }

    private static void WriteEventLogWrapper(string message, bool isError)
    {
        WriteEventLog(message, isError ? DiagLogLevel.Error : DiagLogLevel.Info);
    }

    public static async Task Main(string[] args)
    {
        try
        {
            WriteEventLog("Main: Starting");
            await MainCore(args);
        }
        catch (Exception ex)
        {
            WriteEventLog($"Main: FATAL ERROR - {ex.GetType().Name}: {ex.Message}\n{ex.StackTrace}", DiagLogLevel.Error);
            throw;
        }
    }

    private static async Task MainCore(string[] args)
    {
        WriteEventLog("MainCore: Checking special commands");

        if (CliCommands.HandleSpecialCommands(args))
        {
            return;
        }

        WriteEventLog("MainCore: Acquiring instance guard");

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

        WriteEventLog("MainCore: Parsing args and creating builder");

        var (port, bindAddress) = ArgumentParser.Parse(args);
        var builder = ServerSetup.CreateBuilder(args, WriteEventLogWrapper);

        WriteEventLog("MainCore: Building app");

        var app = builder.Build();
        var version = CliCommands.GetVersion();

        WriteEventLog("MainCore: Resolving services");

        var settingsService = app.Services.GetRequiredService<SettingsService>();
        var updateService = app.Services.GetRequiredService<UpdateService>();
        var authService = app.Services.GetRequiredService<AuthService>();
        var tempCleanupService = app.Services.GetRequiredService<TempCleanupService>();
        var certInfoService = app.Services.GetRequiredService<CertificateInfoService>();

        WriteEventLog($"MainCore: Certificate loaded = {ServerSetup.LoadedCertificate is not null}, IsFallback = {ServerSetup.IsFallbackCertificate}");

        if (ServerSetup.LoadedCertificate is not null)
        {
            certInfoService.SetCertificate(ServerSetup.LoadedCertificate, ServerSetup.IsFallbackCertificate);
        }

        tempCleanupService.CleanupOrphanedFiles();

        var settings = settingsService.Load();
        var logDirectory = LogPaths.GetLogDirectory(settingsService.IsRunningAsService);
        Log.Initialize("mt", logDirectory, settings.LogLevel);
        Log.Info(() => $"MidTerm server starting (LogLevel: {settings.LogLevel})");

        WelcomeScreen.LogStartupStatus(settingsService, settings, port, bindAddress,
            ServerSetup.LoadedCertificate, ServerSetup.IsFallbackCertificate);

        ServerSetup.ConfigureMiddleware(app, settingsService, authService);

        var sessionManager = new TtyHostSessionManager(runAsUser: settings.RunAsUser);
        var muxManager = new TtyHostMuxConnectionManager(sessionManager);

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

        AuthEndpoints.MapAuthEndpoints(app, settingsService, authService);
        EndpointSetup.MapSystemEndpoints(app, sessionManager, updateService, settingsService, version);
        SessionApiEndpoints.MapSessionEndpoints(app, sessionManager);
        EndpointSetup.MapWebSocketMiddleware(app, sessionManager, muxManager, updateService, settingsService, authService, logDirectory);

        var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();

        lifetime.ApplicationStarted.Register(() =>
        {
            Log.Info(() => $"Server fully operational - listening on https://{bindAddress}:{port}");
        });

        lifetime.ApplicationStopping.Register(() =>
        {
            Console.WriteLine("Shutdown requested, cleaning up...");
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
                    tempCleanupService.CleanupAllMidTermFiles();
                    Log.Shutdown();
                    instanceGuard.Dispose();
                }
            });
            cleanupTask.Wait(TimeSpan.FromSeconds(6));
        });

        WelcomeScreen.PrintWelcomeBanner(port, bindAddress, settingsService, version);

        await sessionManager.DiscoverExistingSessionsAsync();

        WriteEventLog($"MainCore: Starting server on https://{bindAddress}:{port}");

        WelcomeScreen.RunWithPortErrorHandling(app, port, bindAddress, WriteEventLogWrapper);
    }
}
