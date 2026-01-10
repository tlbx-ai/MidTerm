using System.Reflection;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Startup;

public static class CliCommands
{
    public static bool HandleSpecialCommands(string[] args)
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
                password = Console.ReadLine() ?? "";
            }
            else
            {
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
            CertificateSetup.GenerateCertificateCommand(force, serviceMode);
            return true;
        }

        return false;
    }

    public static void PrintHelp()
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

    public static string ReadPasswordMasked()
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

    public static string GetVersion()
    {
        var version = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "1.0.0";

        var plusIndex = version.IndexOf('+');
        return plusIndex > 0 ? version[..plusIndex] : version;
    }
}
