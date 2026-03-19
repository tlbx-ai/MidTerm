using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Services.Updates;
using System.Text.RegularExpressions;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class UpdateScriptGeneratorTests : IDisposable
{
    private readonly string _tempDir;
    private readonly string _extractedDir;
    private readonly string _settingsDir;
    private readonly string _currentBinaryPath;

    public UpdateScriptGeneratorTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), $"midterm_update_script_{Guid.NewGuid():N}");
        _extractedDir = Path.Combine(_tempDir, "extracted");
        _settingsDir = Path.Combine(_tempDir, "settings");
        _currentBinaryPath = OperatingSystem.IsWindows()
            ? Path.Combine(_tempDir, "bin", "mt.exe")
            : Path.Combine(_tempDir, "bin", "mt");

        Directory.CreateDirectory(_extractedDir);
        Directory.CreateDirectory(_settingsDir);
        Directory.CreateDirectory(Path.GetDirectoryName(_currentBinaryPath)!);
        File.WriteAllText(_currentBinaryPath, "binary");
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
    public void GenerateUpdateScript_CreatesScriptFileWithPlatformExtension()
    {
        var scriptPath = UpdateScriptGenerator.GenerateUpdateScript(
            _extractedDir,
            _currentBinaryPath,
            _settingsDir,
            UpdateType.Full,
            deleteSourceAfter: true);

        Assert.True(File.Exists(scriptPath));
        Assert.Equal(
            OperatingSystem.IsWindows() ? ".ps1" : ".sh",
            Path.GetExtension(scriptPath),
            ignoreCase: true);
    }

    [Fact]
    public void GenerateUpdateScript_WebOnly_EmitsWebOnlyFlags()
    {
        var scriptText = ReadScript(
            UpdateScriptGenerator.GenerateUpdateScript(
                _extractedDir,
                _currentBinaryPath,
                _settingsDir,
                UpdateType.WebOnly,
                deleteSourceAfter: true));

        Assert.Contains("Web-only", scriptText);

        if (OperatingSystem.IsWindows())
        {
            Assert.True(Regex.IsMatch(scriptText, @"\$IsWebOnly\s*=\s*\$?true", RegexOptions.IgnoreCase));
        }
        else
        {
            Assert.True(Regex.IsMatch(scriptText, @"IS_WEB_ONLY\s*=\s*true", RegexOptions.IgnoreCase));
        }
    }

    [Fact]
    public void GenerateUpdateScript_None_AlsoEmitsWebOnlyFlags()
    {
        var scriptText = ReadScript(
            UpdateScriptGenerator.GenerateUpdateScript(
                _extractedDir,
                _currentBinaryPath,
                _settingsDir,
                UpdateType.None,
                deleteSourceAfter: true));

        Assert.Contains("Web-only", scriptText);

        if (OperatingSystem.IsWindows())
        {
            Assert.True(Regex.IsMatch(scriptText, @"\$IsWebOnly\s*=\s*\$?true", RegexOptions.IgnoreCase));
        }
        else
        {
            Assert.True(Regex.IsMatch(scriptText, @"IS_WEB_ONLY\s*=\s*true", RegexOptions.IgnoreCase));
        }
    }

    [Fact]
    public void GenerateUpdateScript_Full_EmitsFullUpdateFlags()
    {
        var scriptText = ReadScript(
            UpdateScriptGenerator.GenerateUpdateScript(
                _extractedDir,
                _currentBinaryPath,
                _settingsDir,
                UpdateType.Full,
                deleteSourceAfter: true));

        Assert.Contains("Full", scriptText);

        if (OperatingSystem.IsWindows())
        {
            Assert.True(Regex.IsMatch(scriptText, @"\$IsWebOnly\s*=\s*\$?false", RegexOptions.IgnoreCase));
            Assert.Contains("if (-not $IsWebOnly)", scriptText, StringComparison.Ordinal);
        }
        else
        {
            Assert.True(Regex.IsMatch(scriptText, @"IS_WEB_ONLY\s*=\s*false", RegexOptions.IgnoreCase));
            Assert.Contains("if [[ \"$IS_WEB_ONLY\" == \"false\" ]]; then", scriptText, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void GenerateUpdateScript_DeleteSourceFlag_IsConfigurable()
    {
        var scriptText = ReadScript(
            UpdateScriptGenerator.GenerateUpdateScript(
                _extractedDir,
                _currentBinaryPath,
                _settingsDir,
                UpdateType.Full,
                deleteSourceAfter: false));

        if (OperatingSystem.IsWindows())
        {
            Assert.True(Regex.IsMatch(scriptText, @"\$DeleteSource\s*=\s*\$?false", RegexOptions.IgnoreCase));
        }
        else
        {
            Assert.True(Regex.IsMatch(scriptText, @"DELETE_SOURCE\s*=\s*false", RegexOptions.IgnoreCase));
        }
    }

    [Fact]
    public void GenerateUpdateScript_PathsWithSingleQuotes_AreEscaped()
    {
        var extracted = Path.Combine(_tempDir, "O'Brien", "extract");
        var current = OperatingSystem.IsWindows()
            ? Path.Combine(_tempDir, "O'Brien", "bin", "mt.exe")
            : Path.Combine(_tempDir, "O'Brien", "bin", "mt");
        var settings = Path.Combine(_tempDir, "O'Brien", "settings");

        var scriptText = ReadScript(
            UpdateScriptGenerator.GenerateUpdateScript(
                extracted,
                current,
                settings,
                UpdateType.Full,
                deleteSourceAfter: true));

        if (OperatingSystem.IsWindows())
        {
            Assert.Contains("O''Brien", scriptText, StringComparison.Ordinal);
        }
        else
        {
            Assert.Contains("O'\\''Brien", scriptText, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void GenerateUpdateScript_ContainsDistinctInstallAndSettingsDirectories()
    {
        var scriptText = ReadScript(
            UpdateScriptGenerator.GenerateUpdateScript(
                _extractedDir,
                _currentBinaryPath,
                _settingsDir,
                UpdateType.Full,
                deleteSourceAfter: true));

        if (OperatingSystem.IsWindows())
        {
            Assert.Contains("$InstallDir", scriptText, StringComparison.Ordinal);
            Assert.Contains("$SettingsDir", scriptText, StringComparison.Ordinal);
        }
        else
        {
            Assert.Contains("INSTALL_DIR=", scriptText, StringComparison.Ordinal);
            Assert.Contains("CONFIG_DIR=", scriptText, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void GenerateUpdateScript_Linux_StoresBackupsOutsideInstallDirectory()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var scriptText = ReadScript(
            UpdateScriptGenerator.GenerateUpdateScript(
                _extractedDir,
                _currentBinaryPath,
                _settingsDir,
                UpdateType.Full,
                deleteSourceAfter: true));

        Assert.Contains("BACKUP_DIR=", scriptText, StringComparison.Ordinal);
        Assert.Contains("$BACKUP_DIR/mt.bak", scriptText, StringComparison.Ordinal);
        Assert.DoesNotContain("$CURRENT_MT.bak", scriptText, StringComparison.Ordinal);
    }

    [Fact]
    public void GenerateUpdateScript_Linux_UsesResolvedUpdateLogPath()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var scriptText = ReadScript(
            UpdateScriptGenerator.GenerateUpdateScript(
                _extractedDir,
                _currentBinaryPath,
                _settingsDir,
                UpdateType.Full,
                deleteSourceAfter: true));

        Assert.Contains("LOG_FILE='", scriptText, StringComparison.Ordinal);
        Assert.Contains("/logs/update.log", scriptText, StringComparison.Ordinal);
    }

    private static string ReadScript(string path)
    {
        return File.ReadAllText(path);
    }
}
