namespace Ai.Tlbx.MidTerm.Settings;

/// <summary>
/// Indicates how settings were loaded during initialization.
/// </summary>
public enum SettingsLoadStatus
{
    /// <summary>Using default settings (no file found).</summary>
    Default,
    /// <summary>Successfully loaded from settings file.</summary>
    LoadedFromFile,
    /// <summary>Migrated from old settings format.</summary>
    MigratedFromOld,
    /// <summary>Recovered from backup after primary file corruption.</summary>
    RecoveredFromBackup,
    /// <summary>Error occurred, fell back to defaults.</summary>
    ErrorFallbackToDefault
}
