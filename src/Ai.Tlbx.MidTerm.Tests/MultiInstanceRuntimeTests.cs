using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Services.Updates;
using Ai.Tlbx.MidTerm.Settings;
using Ai.Tlbx.MidTerm.Startup;
using Xunit;

namespace Ai.Tlbx.MidTerm.Tests;

public sealed class MultiInstanceRuntimeTests
{
    [Fact]
    public void ArgumentParser_ParseOptions_ReadsUserRuntimeDefaultsWithoutOverridingCli()
    {
        var settingsDir = Path.Combine(Path.GetTempPath(), $"tlbx-runtime-{Guid.NewGuid():N}");
        Directory.CreateDirectory(settingsDir);
        File.WriteAllText(Path.Combine(settingsDir, "runtime.json"), """
            { "port": 2345, "bindAddress": "127.0.0.1" }
            """);
        var originalTlbxPort = Environment.GetEnvironmentVariable(MidTermRuntimeOptions.TlbxPortEnvironmentVariable);
        var originalTlbxBind = Environment.GetEnvironmentVariable(MidTermRuntimeOptions.TlbxBindAddressEnvironmentVariable);
        var originalLegacyPort = Environment.GetEnvironmentVariable(MidTermRuntimeOptions.PortEnvironmentVariable);
        var originalLegacyBind = Environment.GetEnvironmentVariable(MidTermRuntimeOptions.BindAddressEnvironmentVariable);

        try
        {
            Environment.SetEnvironmentVariable(MidTermRuntimeOptions.TlbxPortEnvironmentVariable, null);
            Environment.SetEnvironmentVariable(MidTermRuntimeOptions.TlbxBindAddressEnvironmentVariable, null);
            Environment.SetEnvironmentVariable(MidTermRuntimeOptions.PortEnvironmentVariable, null);
            Environment.SetEnvironmentVariable(MidTermRuntimeOptions.BindAddressEnvironmentVariable, null);

            var defaults = ArgumentParser.ParseOptions(["--user-mode", "--settings-dir", settingsDir]);
            var explicitOptions = ArgumentParser.ParseOptions([
                "--user-mode", "--settings-dir", settingsDir,
                "--port", "3456", "--bind", "0.0.0.0"
            ]);

            Assert.Equal(2345, defaults.Port);
            Assert.Equal("127.0.0.1", defaults.BindAddress);
            Assert.Equal(3456, explicitOptions.Port);
            Assert.Equal("0.0.0.0", explicitOptions.BindAddress);
        }
        finally
        {
            Environment.SetEnvironmentVariable(MidTermRuntimeOptions.TlbxPortEnvironmentVariable, originalTlbxPort);
            Environment.SetEnvironmentVariable(MidTermRuntimeOptions.TlbxBindAddressEnvironmentVariable, originalTlbxBind);
            Environment.SetEnvironmentVariable(MidTermRuntimeOptions.PortEnvironmentVariable, originalLegacyPort);
            Environment.SetEnvironmentVariable(MidTermRuntimeOptions.BindAddressEnvironmentVariable, originalLegacyBind);
            Directory.Delete(settingsDir, recursive: true);
        }
    }

    [Fact]
    public void ArgumentParser_ParseOptions_ReadsInstanceFlags()
    {
        var settingsDir = Path.Combine(Path.GetTempPath(), "midterm-test-instance");

        var options = ArgumentParser.ParseOptions([
            "--port", "2105",
            "--bind", "127.0.0.1",
            "--settings-dir", settingsDir,
            "--service-mode",
            "--service-name", "MidTerm-alice",
            "--launchd-label", "ai.tlbx.midterm.alice",
            "--systemd-service", "midterm-alice"
        ]);

        Assert.Equal(2105, options.Port);
        Assert.Equal("127.0.0.1", options.BindAddress);
        Assert.Equal(settingsDir, options.SettingsDirectory);
        Assert.True(options.ServiceMode);
        Assert.Equal("MidTerm-alice", options.ServiceIdentity.WindowsServiceName);
        Assert.Equal("ai.tlbx.midterm.alice", options.ServiceIdentity.LaunchdLabel);
        Assert.Equal("midterm-alice", options.ServiceIdentity.SystemdServiceName);
    }

    [Fact]
    public void RuntimeOptions_ApplyProcessEnvironment_SetsSettingsAndServiceScope()
    {
        var variableNames = new[]
        {
            MidTermRuntimeOptions.TlbxPortEnvironmentVariable,
            MidTermRuntimeOptions.PortEnvironmentVariable,
            MidTermRuntimeOptions.TlbxBindAddressEnvironmentVariable,
            MidTermRuntimeOptions.BindAddressEnvironmentVariable,
            SettingsService.TlbxSettingsDirectoryEnvironmentVariable,
            SettingsService.SettingsDirectoryEnvironmentVariable,
            MidTermRuntimeOptions.TlbxServiceModeEnvironmentVariable,
            MidTermRuntimeOptions.ServiceModeEnvironmentVariable,
            MidTermServiceIdentity.TlbxWindowsServiceNameEnvironmentVariable,
            MidTermServiceIdentity.WindowsServiceNameEnvironmentVariable,
            MidTermServiceIdentity.TlbxLaunchdLabelEnvironmentVariable,
            MidTermServiceIdentity.LaunchdLabelEnvironmentVariable,
            MidTermServiceIdentity.TlbxSystemdServiceEnvironmentVariable,
            MidTermServiceIdentity.SystemdServiceEnvironmentVariable
        };
        var originalValues = variableNames.ToDictionary(
            static name => name,
            static name => Environment.GetEnvironmentVariable(name),
            StringComparer.Ordinal);

        try
        {
            var settingsDir = Path.Combine(Path.GetTempPath(), "midterm-env-instance");
            var options = new MidTermRuntimeOptions(
                2200,
                "0.0.0.0",
                settingsDir,
                true,
                new MidTermServiceIdentity("MidTerm-env", "ai.tlbx.midterm.env", "midterm-env"));

            options.ApplyProcessEnvironment();

            Assert.Equal(Path.GetFullPath(settingsDir), SettingsService.GetSettingsDirectoryOverride());
            Assert.True(SettingsService.GetServiceModeOverride());
            Assert.Equal("MidTerm-env", Environment.GetEnvironmentVariable(MidTermServiceIdentity.TlbxWindowsServiceNameEnvironmentVariable));
            Assert.Equal("MidTerm-env", Environment.GetEnvironmentVariable(MidTermServiceIdentity.WindowsServiceNameEnvironmentVariable));
        }
        finally
        {
            foreach (var variable in originalValues)
            {
                Environment.SetEnvironmentVariable(variable.Key, variable.Value);
            }
        }
    }

    [Fact]
    public void ArgumentParser_PrefersTlbxEnvironmentAliasesOverLegacyAliases()
    {
        var variables = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            [MidTermRuntimeOptions.TlbxPortEnvironmentVariable] = Environment.GetEnvironmentVariable(MidTermRuntimeOptions.TlbxPortEnvironmentVariable),
            [MidTermRuntimeOptions.PortEnvironmentVariable] = Environment.GetEnvironmentVariable(MidTermRuntimeOptions.PortEnvironmentVariable),
            [MidTermServiceIdentity.TlbxWindowsServiceNameEnvironmentVariable] = Environment.GetEnvironmentVariable(MidTermServiceIdentity.TlbxWindowsServiceNameEnvironmentVariable),
            [MidTermServiceIdentity.WindowsServiceNameEnvironmentVariable] = Environment.GetEnvironmentVariable(MidTermServiceIdentity.WindowsServiceNameEnvironmentVariable)
        };

        try
        {
            Environment.SetEnvironmentVariable(MidTermRuntimeOptions.PortEnvironmentVariable, "2100");
            Environment.SetEnvironmentVariable(MidTermRuntimeOptions.TlbxPortEnvironmentVariable, "2200");
            Environment.SetEnvironmentVariable(MidTermServiceIdentity.WindowsServiceNameEnvironmentVariable, "MidTerm-legacy");
            Environment.SetEnvironmentVariable(MidTermServiceIdentity.TlbxWindowsServiceNameEnvironmentVariable, "tlbx-current");

            var options = ArgumentParser.ParseOptions([]);

            Assert.Equal(2200, options.Port);
            Assert.Equal("tlbx-current", options.ServiceIdentity.WindowsServiceName);
        }
        finally
        {
            foreach (var variable in variables)
            {
                Environment.SetEnvironmentVariable(variable.Key, variable.Value);
            }
        }
    }

    [Fact]
    public void UpdateScriptGenerator_WindowsScript_UsesInstanceServiceName()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var extractedDir = Path.Combine(Path.GetTempPath(), "midterm-update-src");
        var installDir = Path.Combine(Path.GetTempPath(), "midterm-update-install");
        var settingsDir = Path.Combine(Path.GetTempPath(), "midterm-update-settings");
        Directory.CreateDirectory(extractedDir);
        Directory.CreateDirectory(installDir);
        Directory.CreateDirectory(settingsDir);

        var scriptPath = UpdateScriptGenerator.GenerateUpdateScript(
            extractedDir,
            Path.Combine(installDir, "mt.exe"),
            settingsDir,
            new MidTermServiceIdentity("MidTerm-bob", "ai.tlbx.midterm.bob", "midterm-bob"),
            UpdateType.WebOnly);

        try
        {
            var script = File.ReadAllText(scriptPath);
            Assert.Contains("$ServiceName = 'MidTerm-bob'", script, StringComparison.Ordinal);
            Assert.Contains("Get-Service -Name $ServiceName", script, StringComparison.Ordinal);
            Assert.DoesNotContain("Get-Service -Name 'MidTerm'", script, StringComparison.Ordinal);
            Assert.DoesNotContain("Start-Service -Name 'MidTerm'", script, StringComparison.Ordinal);
            Assert.Contains("tlbx.pem", script, StringComparison.Ordinal);
            Assert.DoesNotContain("midterm.pem", script, StringComparison.Ordinal);
        }
        finally
        {
            File.Delete(scriptPath);
        }
    }
}
