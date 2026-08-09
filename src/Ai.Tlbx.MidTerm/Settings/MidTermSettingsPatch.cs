using System.Text.Json;
using System.Text.Json.Nodes;
using Ai.Tlbx.MidTerm.Services;

namespace Ai.Tlbx.MidTerm.Settings;

public static class MidTermSettingsPatch
{
    public static MidTermSettingsPublic Merge(
        MidTermSettingsPublic current,
        JsonElement patch)
    {
        ArgumentNullException.ThrowIfNull(current);
        if (patch.ValueKind != JsonValueKind.Object)
        {
            throw new ArgumentException("Settings payload must be a JSON object.", nameof(patch));
        }

        var merged = JsonSerializer.SerializeToNode(
            current,
            AppJsonContext.Default.MidTermSettingsPublic) as JsonObject
            ?? throw new InvalidOperationException("Failed to serialize current public settings.");

        using var properties = patch.EnumerateObject();
        while (properties.MoveNext())
        {
            var property = properties.Current;
            var existingName = merged
                .Select(entry => entry.Key)
                .FirstOrDefault(name => string.Equals(name, property.Name, StringComparison.OrdinalIgnoreCase));
            var propertyName = existingName ?? property.Name;
            merged[propertyName] = JsonNode.Parse(property.Value.GetRawText());
        }

        return merged.Deserialize(AppJsonContext.Default.MidTermSettingsPublic)
            ?? throw new ArgumentException("Settings payload could not be deserialized.", nameof(patch));
    }
}
