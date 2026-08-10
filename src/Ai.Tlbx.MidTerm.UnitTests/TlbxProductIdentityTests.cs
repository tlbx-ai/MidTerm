using Ai.Tlbx.MidTerm.Common.Identity;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class TlbxProductIdentityTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"tlbx_identity_{Guid.NewGuid():N}");

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_root))
            {
                Directory.Delete(_root, recursive: true);
            }
        }
        catch
        {
        }
    }

    [Fact]
    public void SelectSettingsDirectory_DefaultsToCurrentTlbxLayout()
    {
        var current = Path.Combine(_root, ".tlbx");
        var legacy = Path.Combine(_root, ".midterm");

        Assert.Equal(current, TlbxProductIdentity.SelectSettingsDirectory(current, legacy));
    }

    [Fact]
    public void SelectSettingsDirectory_PreservesMeaningfulLegacyLayout()
    {
        var current = Path.Combine(_root, ".tlbx");
        var legacy = Path.Combine(_root, ".midterm");
        Directory.CreateDirectory(legacy);
        File.WriteAllText(Path.Combine(legacy, "settings.json"), "{}");

        Assert.Equal(legacy, TlbxProductIdentity.SelectSettingsDirectory(current, legacy));
    }

    [Fact]
    public void SelectSettingsDirectory_PrefersCurrentLayoutWhenBothExist()
    {
        var current = Path.Combine(_root, ".tlbx");
        var legacy = Path.Combine(_root, ".midterm");
        Directory.CreateDirectory(current);
        Directory.CreateDirectory(legacy);
        File.WriteAllText(Path.Combine(current, "settings.json"), "{}");
        File.WriteAllText(Path.Combine(legacy, "settings.json"), "{}");

        Assert.Equal(current, TlbxProductIdentity.SelectSettingsDirectory(current, legacy));
    }

    [Fact]
    public void SelectSettingsDirectory_IgnoresLogOnlyCurrentDirectory()
    {
        var current = Path.Combine(_root, ".tlbx");
        var legacy = Path.Combine(_root, ".midterm");
        Directory.CreateDirectory(Path.Combine(current, "logs"));
        Directory.CreateDirectory(legacy);
        File.WriteAllText(Path.Combine(legacy, "settings.json"), "{}");

        Assert.Equal(legacy, TlbxProductIdentity.SelectSettingsDirectory(current, legacy));
    }

    [Fact]
    public void IsLegacySettingsDirectory_RecognizesLegacyMultiInstanceLayout()
    {
        var settingsDirectory = OperatingSystem.IsWindows()
            ? Path.Combine(TlbxProductIdentity.GetLegacyWindowsServiceSettingsDirectory(), "instances", "alice")
            : Path.Combine(TlbxProductIdentity.LegacyUnixMultiInstanceSettingsDirectory, "alice");

        Assert.True(TlbxProductIdentity.IsLegacySettingsDirectory(settingsDirectory));
        Assert.Equal(TlbxProductIdentity.LegacyCertificateFileName, TlbxProductIdentity.GetCertificateFileName(settingsDirectory));
    }
}
