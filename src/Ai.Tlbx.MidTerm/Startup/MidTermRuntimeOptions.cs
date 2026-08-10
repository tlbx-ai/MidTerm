using System.Globalization;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Startup;

public sealed record MidTermRuntimeOptions(
    int Port,
    string BindAddress,
    string? SettingsDirectory,
    bool? ServiceMode,
    MidTermServiceIdentity ServiceIdentity)
{
    public const string TlbxPortEnvironmentVariable = "TLBX_PORT";
    public const string TlbxBindAddressEnvironmentVariable = "TLBX_BIND";
    public const string TlbxServiceModeEnvironmentVariable = "TLBX_SERVICE_MODE";
    public const string PortEnvironmentVariable = "MIDTERM_PORT";
    public const string BindAddressEnvironmentVariable = "MIDTERM_BIND";
    public const string ServiceModeEnvironmentVariable = "MIDTERM_SERVICE_MODE";

    public void ApplyProcessEnvironment()
    {
        Environment.SetEnvironmentVariable(PortEnvironmentVariable, Port.ToString(CultureInfo.InvariantCulture));
        Environment.SetEnvironmentVariable(BindAddressEnvironmentVariable, BindAddress);
        Environment.SetEnvironmentVariable(TlbxPortEnvironmentVariable, Port.ToString(CultureInfo.InvariantCulture));
        Environment.SetEnvironmentVariable(TlbxBindAddressEnvironmentVariable, BindAddress);

        if (!string.IsNullOrWhiteSpace(SettingsDirectory))
        {
            var fullSettingsDirectory = Path.GetFullPath(Environment.ExpandEnvironmentVariables(SettingsDirectory));
            Environment.SetEnvironmentVariable(SettingsService.TlbxSettingsDirectoryEnvironmentVariable, fullSettingsDirectory);
            Environment.SetEnvironmentVariable(SettingsService.SettingsDirectoryEnvironmentVariable, fullSettingsDirectory);
        }

        if (ServiceMode is not null)
        {
            var value = ServiceMode.Value ? "true" : "false";
            Environment.SetEnvironmentVariable(TlbxServiceModeEnvironmentVariable, value);
            Environment.SetEnvironmentVariable(ServiceModeEnvironmentVariable, value);
        }

        ServiceIdentity.ApplyProcessEnvironment();
    }
}
