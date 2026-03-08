using System.Text.Json;
using Ai.Tlbx.MidTerm.Settings;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class SettingsServiceTests : IDisposable
{
    private readonly string _tempDir;

    public SettingsServiceTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), $"midterm_settings_tests_{Guid.NewGuid():N}");
        Directory.CreateDirectory(_tempDir);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_tempDir))
            {
                Directory.Delete(_tempDir, recursive: true);
            }
        }
        catch
        {
        }
    }

    [Fact]
    public void Load_NoSettingsFile_ReturnsDefaults()
    {
        if (!OperatingSystem.IsWindows()) return;

        var service = new SettingsService(_tempDir);

        var settings = service.Load();

        Assert.Equal(SettingsLoadStatus.Default, service.LoadStatus);
        Assert.True(settings.UseWebGL);
        Assert.True(settings.CursorBlink);
        Assert.True(settings.RightClickPaste);
        Assert.True(settings.FileRadar);
        Assert.True(settings.ManagerBarEnabled);
        Assert.True(settings.TmuxCompatibility);
        Assert.True(settings.IdeMode);
        Assert.True(settings.ShowChangelogAfterUpdate);
        Assert.True(settings.ShowUpdateNotification);
    }

    [Fact]
    public void Load_MissingBooleanKeys_AppliesTrueDefaults()
    {
        if (!OperatingSystem.IsWindows()) return;

        File.WriteAllText(Path.Combine(_tempDir, "settings.json"), "{ }");
        var service = new SettingsService(_tempDir);

        var settings = service.Load();

        Assert.True(settings.UseWebGL);
        Assert.True(settings.CursorBlink);
        Assert.True(settings.RightClickPaste);
        Assert.True(settings.FileRadar);
        Assert.True(settings.ManagerBarEnabled);
        Assert.True(settings.TmuxCompatibility);
        Assert.True(settings.IdeMode);
        Assert.True(settings.ShowChangelogAfterUpdate);
        Assert.True(settings.ShowUpdateNotification);
    }

    [Fact]
    public void Load_ExplicitFalseBooleans_Preserved()
    {
        if (!OperatingSystem.IsWindows()) return;

        var json = """
        {
          "useWebGL": false,
          "cursorBlink": false,
          "rightClickPaste": false,
          "fileRadar": false,
          "managerBarEnabled": false,
          "tmuxCompatibility": false,
          "ideMode": false,
          "showChangelogAfterUpdate": false,
          "showUpdateNotification": false
        }
        """;
        File.WriteAllText(Path.Combine(_tempDir, "settings.json"), json);
        var service = new SettingsService(_tempDir);

        var settings = service.Load();

        Assert.False(settings.UseWebGL);
        Assert.False(settings.CursorBlink);
        Assert.False(settings.RightClickPaste);
        Assert.False(settings.FileRadar);
        Assert.False(settings.ManagerBarEnabled);
        Assert.False(settings.TmuxCompatibility);
        Assert.False(settings.IdeMode);
        Assert.False(settings.ShowChangelogAfterUpdate);
        Assert.False(settings.ShowUpdateNotification);
    }

    [Fact]
    public void Load_InvalidJson_FallsBackToDefaultAndCapturesError()
    {
        if (!OperatingSystem.IsWindows()) return;

        File.WriteAllText(Path.Combine(_tempDir, "settings.json"), "{not valid");
        var service = new SettingsService(_tempDir);

        var settings = service.Load();

        Assert.NotNull(settings);
        Assert.Equal(SettingsLoadStatus.ErrorFallbackToDefault, service.LoadStatus);
        Assert.False(string.IsNullOrWhiteSpace(service.LoadError));
    }

    [Fact]
    public void Save_SecretsArePersistedSecurely_NotInSettingsJson()
    {
        if (!OperatingSystem.IsWindows()) return;

        var service = new SettingsService(_tempDir);
        var settings = service.Load();
        settings.PasswordHash = "pw-hash";
        settings.SessionSecret = Convert.ToBase64String(Guid.NewGuid().ToByteArray());
        settings.CertificatePassword = "cert-pass";
        settings.VoiceServerPassword = "voice-pass";
        settings.UpdateChannel = "dev";

        service.Save(settings);

        var savedJson = File.ReadAllText(Path.Combine(_tempDir, "settings.json"));
        Assert.DoesNotContain("pw-hash", savedJson, StringComparison.Ordinal);
        Assert.DoesNotContain("cert-pass", savedJson, StringComparison.Ordinal);
        Assert.DoesNotContain("voice-pass", savedJson, StringComparison.Ordinal);

        var reloadedService = new SettingsService(_tempDir);
        var reloaded = reloadedService.Load();
        Assert.Equal("pw-hash", reloaded.PasswordHash);
        Assert.Equal(settings.SessionSecret, reloaded.SessionSecret);
        Assert.Equal("cert-pass", reloaded.CertificatePassword);
        Assert.Equal("voice-pass", reloaded.VoiceServerPassword);
        Assert.Equal("dev", reloaded.UpdateChannel);
    }

    [Fact]
    public void Save_NullCertificatePassword_DeletesStoredSecret()
    {
        if (!OperatingSystem.IsWindows()) return;

        var service = new SettingsService(_tempDir);
        var settings = service.Load();
        settings.CertificatePassword = "first";
        service.Save(settings);

        settings.CertificatePassword = null;
        service.Save(settings);

        var reloaded = new SettingsService(_tempDir).Load();
        Assert.Null(reloaded.CertificatePassword);
    }

    [Fact]
    public void InvalidateCache_ForcesReloadFromDisk()
    {
        if (!OperatingSystem.IsWindows()) return;

        var service = new SettingsService(_tempDir);
        var first = service.Load();
        Assert.Equal(14, first.FontSize);

        File.WriteAllText(
            Path.Combine(_tempDir, "settings.json"),
            """
            {
              "fontSize": 31
            }
            """);

        var cached = service.Load();
        Assert.Equal(14, cached.FontSize);

        service.InvalidateCache();
        var refreshed = service.Load();
        Assert.Equal(31, refreshed.FontSize);
    }

    [Fact]
    public void Load_MergeSettingsFile_MergesAndDeletesSource()
    {
        if (!OperatingSystem.IsWindows()) return;

        var settingsPath = Path.Combine(_tempDir, "settings.json");
        var mergePath = Path.Combine(_tempDir, "merge-settings.json");

        var current = new MidTermSettings
        {
            UpdateChannel = "stable",
            AuthenticationEnabled = false
        };
        File.WriteAllText(settingsPath, JsonSerializer.Serialize(current, SettingsJsonContext.Default.MidTermSettings));

        var merge = new MidTermSettings
        {
            RunAsUser = "alice",
            RunAsUserSid = "S-1-5-21-test",
            AuthenticationEnabled = true,
            IsServiceInstall = true,
            UpdateChannel = "dev",
            CertificatePath = @"C:\certs\midterm.pem",
            KeyProtection = KeyProtectionMethod.OsProtected
        };
        File.WriteAllText(mergePath, JsonSerializer.Serialize(merge, SettingsJsonContext.Default.MidTermSettings));

        var service = new SettingsService(_tempDir);
        var loaded = service.Load();

        Assert.Equal("alice", loaded.RunAsUser);
        Assert.Equal("S-1-5-21-test", loaded.RunAsUserSid);
        Assert.True(loaded.AuthenticationEnabled);
        Assert.True(loaded.IsServiceInstall);
        Assert.Equal("dev", loaded.UpdateChannel);
        Assert.Equal(@"C:\certs\midterm.pem", loaded.CertificatePath);
        Assert.False(File.Exists(mergePath));
    }

    [Fact]
    public void Load_MergeSettings_DoesNotDowngradeDevChannelToStable()
    {
        if (!OperatingSystem.IsWindows()) return;

        var settingsPath = Path.Combine(_tempDir, "settings.json");
        var mergePath = Path.Combine(_tempDir, "merge-settings.json");

        var current = new MidTermSettings { UpdateChannel = "dev" };
        File.WriteAllText(settingsPath, JsonSerializer.Serialize(current, SettingsJsonContext.Default.MidTermSettings));

        var merge = new MidTermSettings { UpdateChannel = "stable" };
        File.WriteAllText(mergePath, JsonSerializer.Serialize(merge, SettingsJsonContext.Default.MidTermSettings));

        var service = new SettingsService(_tempDir);
        var loaded = service.Load();

        Assert.Equal("dev", loaded.UpdateChannel);
        Assert.False(File.Exists(mergePath));
    }

    [Fact]
    public void Load_OldSettingsFile_MigratesPreferences_AndDeletesOldFile()
    {
        if (!OperatingSystem.IsWindows()) return;

        var currentPath = Path.Combine(_tempDir, "settings.json");
        var oldPath = currentPath + ".old";

        var current = new MidTermSettings
        {
            FontSize = 14,
            CertificatePath = null
        };
        var old = new MidTermSettings
        {
            FontSize = 22,
            HideCursorOnInputBursts = true,
            RightClickPaste = false,
            Theme = ThemeSetting.Light,
            BackgroundImageEnabled = true,
            BackgroundImageFileName = "wallpaper.png",
            BackgroundImageRevision = 12345,
            BackgroundImageFit = "contain",
            UiTransparency = 40,
            TerminalEnterMode = TerminalEnterModeSetting.ShiftEnterLineFeed,
            CertificatePath = @"C:\legacy\midterm.pem",
            KeyProtection = KeyProtectionMethod.OsProtected
        };

        File.WriteAllText(currentPath, JsonSerializer.Serialize(current, SettingsJsonContext.Default.MidTermSettings));
        File.WriteAllText(oldPath, JsonSerializer.Serialize(old, SettingsJsonContext.Default.MidTermSettings));

        var service = new SettingsService(_tempDir);
        var loaded = service.Load();

        Assert.Equal(22, loaded.FontSize);
        Assert.True(loaded.HideCursorOnInputBursts);
        Assert.False(loaded.RightClickPaste);
        Assert.Equal(ThemeSetting.Light, loaded.Theme);
        Assert.True(loaded.BackgroundImageEnabled);
        Assert.Equal("wallpaper.png", loaded.BackgroundImageFileName);
        Assert.Equal(12345, loaded.BackgroundImageRevision);
        Assert.Equal("contain", loaded.BackgroundImageFit);
        Assert.Equal(40, loaded.UiTransparency);
        Assert.Equal(TerminalEnterModeSetting.ShiftEnterLineFeed, loaded.TerminalEnterMode);
        Assert.Equal(@"C:\legacy\midterm.pem", loaded.CertificatePath);
        Assert.False(File.Exists(oldPath));
        Assert.Equal(SettingsLoadStatus.MigratedFromOld, service.LoadStatus);
    }

    [Fact]
    public void Load_InvalidMergeSettings_DeletesMergeFileAndContinues()
    {
        if (!OperatingSystem.IsWindows()) return;

        var settingsPath = Path.Combine(_tempDir, "settings.json");
        var mergePath = Path.Combine(_tempDir, "merge-settings.json");

        File.WriteAllText(settingsPath, "{}");
        File.WriteAllText(mergePath, "{this is invalid json");

        var service = new SettingsService(_tempDir);
        var loaded = service.Load();

        Assert.NotNull(loaded);
        Assert.False(File.Exists(mergePath));
    }

    [Fact]
    public void SettingsListeners_AreCalledOnSave_AndCanBeRemoved()
    {
        if (!OperatingSystem.IsWindows()) return;

        var service = new SettingsService(_tempDir);
        var calls = 0;
        var id = service.AddSettingsListener(_ => calls++);

        var settings = service.Load();
        settings.FontSize = 17;
        service.Save(settings);
        Assert.Equal(1, calls);

        service.RemoveSettingsListener(id);
        settings.FontSize = 18;
        service.Save(settings);
        Assert.Equal(1, calls);
    }
}
