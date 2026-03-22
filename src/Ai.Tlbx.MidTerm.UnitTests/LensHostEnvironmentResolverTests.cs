using System.Diagnostics;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Ai.Tlbx.MidTerm.Settings;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class LensHostEnvironmentResolverTests
{
    [Fact]
    public void ApplyUserProfileEnvironment_DoesNothing_WhenRunAsUserMissing()
    {
        var startInfo = new ProcessStartInfo();
        var settings = new MidTermSettings();
        var originalUserProfile = startInfo.Environment.TryGetValue("USERPROFILE", out var userProfile)
            ? userProfile
            : null;
        var originalCodexHome = startInfo.Environment.TryGetValue("CODEX_HOME", out var codexHome)
            ? codexHome
            : null;

        LensHostEnvironmentResolver.ApplyUserProfileEnvironment(startInfo, settings);

        Assert.Equal(originalUserProfile, startInfo.Environment.TryGetValue("USERPROFILE", out var currentUserProfile) ? currentUserProfile : null);
        Assert.Equal(originalCodexHome, startInfo.Environment.TryGetValue("CODEX_HOME", out var currentCodexHome) ? currentCodexHome : null);
    }

    [Fact]
    public void ResolveWindowsProfileDirectory_FallsBackToUsersRoot()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var profileDirectory = LensHostEnvironmentResolver.ResolveWindowsProfileDirectory("johan", userSid: null);

        Assert.NotNull(profileDirectory);
        Assert.EndsWith(Path.Combine("Users", "johan"), profileDirectory!, StringComparison.OrdinalIgnoreCase);
    }
}
