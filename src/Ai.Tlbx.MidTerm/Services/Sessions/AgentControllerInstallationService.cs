using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public sealed class AgentControllerInstallationService(SettingsService settingsService)
{
    public IReadOnlyList<AgentControllerInstallationDto> GetInstalled()
    {
        var settings = settingsService.Load();
        var userProfileDirectory = AppServerControlHostEnvironmentResolver.ResolveWindowsProfileDirectory(
            settings.RunAsUser,
            settings.RunAsUserSid);
        var installed = new List<AgentControllerInstallationDto>();

        AddIfInstalled(
            installed,
            AiCliProfileService.CodexProfile,
            "Codex",
            "Codex app-server",
            "codex",
            supportsResume: true,
            userProfileDirectory);

        foreach (var definition in AcpAgentDefinitions.All)
        {
            AddIfInstalled(
                installed,
                definition.Profile,
                definition.Name,
                "ACP v1",
                string.Join(' ', [definition.CommandName, .. definition.Arguments]),
                supportsResume: false,
                userProfileDirectory,
                definition.CommandName);
        }

        return installed;
    }

    private static void AddIfInstalled(
        List<AgentControllerInstallationDto> installed,
        string profile,
        string name,
        string protocol,
        string command,
        bool supportsResume,
        string? userProfileDirectory,
        string? commandName = null)
    {
        if (AiCliCommandLocator.FindExecutableInPath(commandName ?? profile, userProfileDirectory) is null)
        {
            return;
        }

        installed.Add(new AgentControllerInstallationDto
        {
            Profile = profile,
            Name = name,
            Protocol = protocol,
            Command = command,
            SupportsResume = supportsResume
        });
    }
}
