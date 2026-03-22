using System.Text.Json;
using System.Text.Json.Serialization;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

internal sealed class TtyHostOwnershipRegistry
{
    private readonly string _path;
    private readonly Lock _lock = new();
    private RegistryState _state;

    public TtyHostOwnershipRegistry(string path)
    {
        _path = path;
        _state = LoadState(path);
    }

    public IReadOnlyList<OwnedTtyHostRecord> GetSessions()
    {
        lock (_lock)
        {
            return _state.Sessions
                .Select(static session => new OwnedTtyHostRecord
                {
                    SessionId = session.SessionId,
                    HostPid = session.HostPid,
                    IsLegacyEndpoint = session.IsLegacyEndpoint,
                    LastSeenUtc = session.LastSeenUtc
                })
                .ToList();
        }
    }

    public void Upsert(string sessionId, int hostPid, bool isLegacyEndpoint)
    {
        lock (_lock)
        {
            var existing = _state.Sessions.FirstOrDefault(session => string.Equals(session.SessionId, sessionId, StringComparison.Ordinal));
            if (existing is null)
            {
                _state.Sessions.Add(new OwnedTtyHostRecord
                {
                    SessionId = sessionId,
                    HostPid = hostPid,
                    IsLegacyEndpoint = isLegacyEndpoint,
                    LastSeenUtc = DateTime.UtcNow
                });
            }
            else
            {
                existing.HostPid = hostPid;
                existing.IsLegacyEndpoint = isLegacyEndpoint;
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
            return JsonSerializer.Deserialize(json, TtyHostOwnershipRegistryJsonContext.Default.RegistryState)
                   ?? new RegistryState();
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"TtyHostOwnershipRegistry load failed: {ex.Message}");
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

            var json = JsonSerializer.Serialize(_state, TtyHostOwnershipRegistryJsonContext.Default.RegistryState);
            var tempPath = _path + ".tmp";
            File.WriteAllText(tempPath, json);
            File.Move(tempPath, _path, overwrite: true);
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"TtyHostOwnershipRegistry save failed: {ex.Message}");
        }
    }

    internal sealed class RegistryState
    {
        public List<OwnedTtyHostRecord> Sessions { get; set; } = [];
    }
}

internal sealed class OwnedTtyHostRecord
{
    public string SessionId { get; set; } = string.Empty;
    public int HostPid { get; set; }
    public bool IsLegacyEndpoint { get; set; }
    public DateTime LastSeenUtc { get; set; }
}

[JsonSerializable(typeof(TtyHostOwnershipRegistry.RegistryState))]
[JsonSerializable(typeof(OwnedTtyHostRecord))]
internal partial class TtyHostOwnershipRegistryJsonContext : JsonSerializerContext
{
}
