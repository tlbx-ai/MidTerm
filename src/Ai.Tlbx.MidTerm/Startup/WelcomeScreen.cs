using System.Security.Cryptography.X509Certificates;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Startup;

public static class WelcomeScreen
{
    public static void PrintWelcomeBanner(int port, string bindAddress, SettingsService settingsService, string version)
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
        Console.WriteLine("by J. Schmidt - https://github.com/tlbx-ai");

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
            Console.Write(" [LOCAL]");
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

    public static void LogStartupStatus(
        SettingsService settingsService,
        MidTermSettings settings,
        int port,
        string bindAddress,
        X509Certificate2? loadedCertificate,
        bool isFallbackCertificate)
    {
        var settingsStatus = settingsService.LoadStatus switch
        {
            SettingsLoadStatus.LoadedFromFile => $"loaded from {settingsService.SettingsPath}",
            SettingsLoadStatus.MigratedFromOld => $"migrated from {settingsService.SettingsPath}.old",
            SettingsLoadStatus.ErrorFallbackToDefault => $"ERROR loading {settingsService.SettingsPath}: {settingsService.LoadError}",
            _ => "using defaults (no settings file)"
        };
        Log.Info(() => $"Settings: {settingsStatus}");

        Log.Info(() => $"Mode: {(settingsService.IsRunningAsService ? "Service" : "User")}");

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

        if (loadedCertificate is not null)
        {
            if (isFallbackCertificate)
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

        Log.Info(() => $"Binding: https://{bindAddress}:{port}");
    }

    public static void RunWithPortErrorHandling(
        WebApplication app,
        int port,
        string bindAddress,
        Action<string, bool>? writeEventLog = null)
    {
        writeEventLog?.Invoke($"RunWithPortErrorHandling: About to call app.Run on https://{bindAddress}:{port}", false);

        try
        {
            app.Run($"https://{bindAddress}:{port}");
            writeEventLog?.Invoke("RunWithPortErrorHandling: app.Run completed normally", false);
        }
        catch (IOException ex) when (ex.InnerException is System.Net.Sockets.SocketException socketEx &&
            socketEx.SocketErrorCode == System.Net.Sockets.SocketError.AddressAlreadyInUse)
        {
            writeEventLog?.Invoke($"RunWithPortErrorHandling: Port {port} already in use", true);
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
        catch (Exception ex)
        {
            writeEventLog?.Invoke($"RunWithPortErrorHandling: UNEXPECTED ERROR - {ex.GetType().Name}: {ex.Message}\n{ex.StackTrace}", true);
            throw;
        }
    }
}
