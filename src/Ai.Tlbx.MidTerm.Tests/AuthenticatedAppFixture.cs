using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Ai.Tlbx.MidTerm.Tests;

public sealed class AuthenticatedAppFixture : WebApplicationFactory<Program>
{
    public const string Password = "isolated-integration-test-password";
    private readonly string _directory = Path.Combine(Path.GetTempPath(), $"tlbx-integration-{Guid.NewGuid():N}");
    private readonly Dictionary<string, string?> _previousEnvironment = new(StringComparer.Ordinal);

    public AuthenticatedAppFixture()
    {
        Directory.CreateDirectory(_directory);
        foreach (var name in new[] { SettingsService.TlbxSettingsDirectoryEnvironmentVariable, SettingsService.SettingsDirectoryEnvironmentVariable })
        {
            _previousEnvironment[name] = Environment.GetEnvironmentVariable(name);
            Environment.SetEnvironmentVariable(name, _directory);
        }
        var service = new SettingsService();
        var settings = service.Load();
        settings.PasswordHash = AuthService.HashPasswordStatic(Password);
        settings.AuthenticationEnabled = true;
        service.Save(settings);
    }

    protected override void Dispose(bool disposing)
    {
        try { base.Dispose(disposing); }
        finally
        {
            if (disposing)
            {
                foreach (var entry in _previousEnvironment)
                    Environment.SetEnvironmentVariable(entry.Key, entry.Value);
                // SQLite pools outlive the disposed test host unless explicitly drained.
                Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
                if (Directory.Exists(_directory)) Directory.Delete(_directory, recursive: true);
            }
        }
    }
}
