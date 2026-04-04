using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Services.Hosting;

public sealed class MidTermInstanceIdentity
{
    private const string ScopeFileName = "instance-scope.json";
    private const string LegacyImportFileName = "legacy-ttyhost-import.json";

    private readonly string _settingsDirectory;

    private MidTermInstanceIdentity(
        string settingsDirectory,
        string installScopeId,
        string ownerToken,
        string instanceId,
        int port)
    {
        _settingsDirectory = settingsDirectory;
        InstallScopeId = installScopeId;
        OwnerToken = ownerToken;
        InstanceId = instanceId;
        Port = port;
    }

    public string InstallScopeId { get; }
    public string OwnerToken { get; }
    public string InstanceId { get; }
    public int Port { get; }
    public string SettingsGuardName => $"midterm-settings-{InstallScopeId}";
    public string PortGuardName => $"midterm-port-{InstanceId}";
    public string SessionRegistryPath => Path.Combine(_settingsDirectory, $"tty-sessions-{InstanceId}.json");

    public static MidTermInstanceIdentity Load(string settingsDirectory, int port)
    {
        Directory.CreateDirectory(settingsDirectory);

        var scopePath = Path.Combine(settingsDirectory, ScopeFileName);
        InstanceScopeData? scope = null;

        try
        {
            if (File.Exists(scopePath))
            {
                var json = File.ReadAllText(scopePath);
                scope = JsonSerializer.Deserialize(json, MidTermInstanceIdentityJsonContext.Default.InstanceScopeData);
            }
        }
        catch
        {
            scope = null;
        }

        if (scope is null ||
            string.IsNullOrWhiteSpace(scope.InstallScopeId) ||
            string.IsNullOrWhiteSpace(scope.OwnerToken))
        {
            scope = new InstanceScopeData
            {
                InstallScopeId = Guid.NewGuid().ToString("N"),
                OwnerToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant()
            };

            var json = JsonSerializer.Serialize(scope, MidTermInstanceIdentityJsonContext.Default.InstanceScopeData);
            var tempPath = scopePath + ".tmp";
            File.WriteAllText(tempPath, json);
            File.Move(tempPath, scopePath, overwrite: true);
        }

        var instanceId = ComputeInstanceId(scope.InstallScopeId, port);
        return new MidTermInstanceIdentity(settingsDirectory, scope.InstallScopeId, scope.OwnerToken, instanceId, port);
    }

    public bool CanImportLegacySessions()
    {
        var path = Path.Combine(_settingsDirectory, LegacyImportFileName);
        try
        {
            if (!File.Exists(path))
            {
                return true;
            }

            var json = File.ReadAllText(path);
            var marker = JsonSerializer.Deserialize(json, MidTermInstanceIdentityJsonContext.Default.LegacyImportMarker);
            return marker is not null && string.Equals(marker.InstanceId, InstanceId, StringComparison.Ordinal);
        }
        catch
        {
            return false;
        }
    }

    public void MarkLegacySessionsImported()
    {
        var path = Path.Combine(_settingsDirectory, LegacyImportFileName);
        var marker = new LegacyImportMarker
        {
            InstanceId = InstanceId,
            ImportedAtUtc = DateTime.UtcNow
        };

        var json = JsonSerializer.Serialize(marker, MidTermInstanceIdentityJsonContext.Default.LegacyImportMarker);
        var tempPath = path + ".tmp";
        File.WriteAllText(tempPath, json);
        File.Move(tempPath, path, overwrite: true);
    }

    public string GetShortInstanceId()
    {
        return InstanceId.Length <= 8 ? InstanceId : InstanceId[..8];
    }

    private static string ComputeInstanceId(string installScopeId, int port)
    {
        var input = Encoding.UTF8.GetBytes(string.Create(CultureInfo.InvariantCulture, $"{installScopeId}|{port}"));
        return Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant()[..16];
    }

    public sealed class InstanceScopeData
    {
        public string InstallScopeId { get; set; } = string.Empty;
        public string OwnerToken { get; set; } = string.Empty;
    }

    public sealed class LegacyImportMarker
    {
        public string InstanceId { get; set; } = string.Empty;
        public DateTime ImportedAtUtc { get; set; }
    }
}

[JsonSerializable(typeof(MidTermInstanceIdentity.InstanceScopeData))]
[JsonSerializable(typeof(MidTermInstanceIdentity.LegacyImportMarker))]
internal partial class MidTermInstanceIdentityJsonContext : JsonSerializerContext
{
}
