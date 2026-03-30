using System.Text.Json;
using System.Text.Json.Serialization;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

internal sealed class LensHostOwnershipRegistry
{
    private readonly string _path;
    private readonly Lock _lock = new();
    private RegistryState _state;

    public LensHostOwnershipRegistry(string path)
    {
        _path = path;
        _state = LoadState(path);
    }

    public IReadOnlyList<OwnedLensHostRecord> GetSessions()
    {
        lock (_lock)
        {
            return _state.Sessions
                .Select(static session => new OwnedLensHostRecord
                {
                    SessionId = session.SessionId,
                    HostPid = session.HostPid,
                    Profile = session.Profile,
                    WorkingDirectory = session.WorkingDirectory,
                    LastSeenUtc = session.LastSeenUtc
                })
                .ToList();
        }
    }

    public void Upsert(string sessionId, int hostPid, string profile, string? workingDirectory)
    {
        lock (_lock)
        {
            var existing = _state.Sessions.FirstOrDefault(session => string.Equals(session.SessionId, sessionId, StringComparison.Ordinal));
            if (existing is null)
            {
                _state.Sessions.Add(new OwnedLensHostRecord
                {
                    SessionId = sessionId,
                    HostPid = hostPid,
                    Profile = profile,
                    WorkingDirectory = workingDirectory,
                    LastSeenUtc = DateTime.UtcNow
                });
            }
            else
            {
                existing.HostPid = hostPid;
                existing.Profile = profile;
                existing.WorkingDirectory = workingDirectory;
                existing.LastSeenUtc = DateTime.UtcNow;
            }

            SaveState();
        }
    }

    public void Remove(string sessionId)
    {
        lock (_lock)
        {
            _state.Sessions.RemoveAll(session => string.Equals(session.SessionId, sessionId, StringComparison.Ordinal));
            SaveState();
        }
    }

    private static RegistryState LoadState(string path)
    {
        try
        {
            if (!File.Exists(path))
            {
                return new RegistryState();
            }

            var json = File.ReadAllText(path);
            return JsonSerializer.Deserialize(json, LensHostOwnershipRegistryJsonContext.Default.RegistryState)
                   ?? new RegistryState();
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"LensHostOwnershipRegistry load failed: {ex.Message}");
            return new RegistryState();
        }
    }

    private void SaveState()
    {
        try
        {
            var directory = Path.GetDirectoryName(_path);
            if (!string.IsNullOrWhiteSpace(directory))
            {
                Directory.CreateDirectory(directory);
            }

            var json = JsonSerializer.Serialize(_state, LensHostOwnershipRegistryJsonContext.Default.RegistryState);
            var tempPath = _path + ".tmp";
            File.WriteAllText(tempPath, json);
            File.Move(tempPath, _path, overwrite: true);
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"LensHostOwnershipRegistry save failed: {ex.Message}");
        }
    }

    internal sealed class RegistryState
    {
        public List<OwnedLensHostRecord> Sessions { get; set; } = [];
    }
}

internal sealed class OwnedLensHostRecord
{
    public string SessionId { get; set; } = string.Empty;
    public int HostPid { get; set; }
    public string Profile { get; set; } = string.Empty;
    public string? WorkingDirectory { get; set; }
    public DateTime LastSeenUtc { get; set; }
}

[JsonSerializable(typeof(LensHostOwnershipRegistry.RegistryState))]
[JsonSerializable(typeof(OwnedLensHostRecord))]
internal partial class LensHostOwnershipRegistryJsonContext : JsonSerializerContext
{
}
