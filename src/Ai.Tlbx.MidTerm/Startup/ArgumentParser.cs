using System.Globalization;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Identity;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Startup;

public static class ArgumentParser
{
    public const int DefaultPort = 2000;
    public const string DefaultBindAddress = "0.0.0.0";

    public static (int port, string bindAddress) Parse(string[] args)
    {
        var options = ParseOptions(args);
        return (options.Port, options.BindAddress);
    }

    public static MidTermRuntimeOptions ParseOptions(string[] args)
    {
        var port = DefaultPort;
        var bindAddress = DefaultBindAddress;
        string? settingsDirectory = null;
        bool? serviceMode = null;
        var serviceIdentity = MidTermServiceIdentity.FromEnvironment();
        var portWasSpecified = false;
        var bindWasSpecified = false;

        var envPort = Environment.GetEnvironmentVariable(MidTermRuntimeOptions.TlbxPortEnvironmentVariable)
            ?? Environment.GetEnvironmentVariable(MidTermRuntimeOptions.PortEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(envPort) &&
            int.TryParse(envPort, CultureInfo.InvariantCulture, out var parsedEnvPort))
        {
            port = parsedEnvPort;
            portWasSpecified = true;
        }

        var envBind = Environment.GetEnvironmentVariable(MidTermRuntimeOptions.TlbxBindAddressEnvironmentVariable)
            ?? Environment.GetEnvironmentVariable(MidTermRuntimeOptions.BindAddressEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(envBind))
        {
            bindAddress = envBind.Trim();
            bindWasSpecified = true;
        }

        settingsDirectory = SettingsService.GetSettingsDirectoryOverride();

        var envServiceMode = Environment.GetEnvironmentVariable(MidTermRuntimeOptions.TlbxServiceModeEnvironmentVariable)
            ?? Environment.GetEnvironmentVariable(MidTermRuntimeOptions.ServiceModeEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(envServiceMode) &&
            bool.TryParse(envServiceMode, out var parsedServiceMode))
        {
            serviceMode = parsedServiceMode;
        }

        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--port" && i + 1 < args.Length && int.TryParse(args[i + 1], CultureInfo.InvariantCulture, out var p))
            {
                port = p;
                portWasSpecified = true;
                i++;
            }
            else if (args[i] == "--bind" && i + 1 < args.Length)
            {
                bindAddress = args[i + 1];
                bindWasSpecified = true;
                i++;
            }
            else if (args[i] == "--settings-dir" && i + 1 < args.Length)
            {
                settingsDirectory = args[i + 1];
                i++;
            }
            else if (args[i] == "--service-mode")
            {
                serviceMode = true;
            }
            else if (args[i] == "--user-mode")
            {
                serviceMode = false;
            }
            else if (args[i] == "--service-name" && i + 1 < args.Length)
            {
                serviceIdentity = serviceIdentity with { WindowsServiceName = args[i + 1] };
                i++;
            }
            else if (args[i] == "--launchd-label" && i + 1 < args.Length)
            {
                serviceIdentity = serviceIdentity with { LaunchdLabel = args[i + 1] };
                i++;
            }
            else if (args[i] == "--systemd-service" && i + 1 < args.Length)
            {
                serviceIdentity = serviceIdentity with { SystemdServiceName = args[i + 1] };
                i++;
            }
        }

        if (serviceMode != true && (!portWasSpecified || !bindWasSpecified))
        {
            var userSettingsDirectory = settingsDirectory ?? TlbxProductIdentity.SelectSettingsDirectory(
                TlbxProductIdentity.GetUserSettingsDirectory(),
                TlbxProductIdentity.GetLegacyUserSettingsDirectory());
            ApplyUserRuntimeDefaults(
                userSettingsDirectory,
                ref port,
                ref bindAddress,
                portWasSpecified,
                bindWasSpecified);
        }

        return new MidTermRuntimeOptions(
            port,
            bindAddress,
            settingsDirectory,
            serviceMode,
            serviceIdentity);
    }

    private static void ApplyUserRuntimeDefaults(
        string settingsDirectory,
        ref int port,
        ref string bindAddress,
        bool portWasSpecified,
        bool bindWasSpecified)
    {
        try
        {
            var path = Path.Combine(settingsDirectory, "runtime.json");
            if (!File.Exists(path))
            {
                return;
            }

            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var root = document.RootElement;
            if (!portWasSpecified &&
                root.TryGetProperty("port", out var configuredPort) &&
                configuredPort.TryGetInt32(out var parsedPort) &&
                parsedPort is >= 1 and <= 65535)
            {
                port = parsedPort;
            }

            if (!bindWasSpecified &&
                root.TryGetProperty("bindAddress", out var configuredBind) &&
                configuredBind.ValueKind == JsonValueKind.String &&
                !string.IsNullOrWhiteSpace(configuredBind.GetString()))
            {
                bindAddress = configuredBind.GetString()!.Trim();
            }
        }
        catch
        {
            // A malformed optional launcher profile must not prevent explicit
            // command-line and environment configuration from working.
        }
    }
}
