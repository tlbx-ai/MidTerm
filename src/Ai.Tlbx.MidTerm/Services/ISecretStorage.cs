namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Interface for platform-specific secret storage (DPAPI on Windows, file-based on Unix).
/// </summary>
public interface ISecretStorage
{
    /// <summary>Gets a secret value by key, or null if not found.</summary>
    string? GetSecret(string key);
    /// <summary>Sets or updates a secret value.</summary>
    void SetSecret(string key, string value);
    /// <summary>Deletes a secret by key.</summary>
    void DeleteSecret(string key);

    /// <summary>True if secret storage failed to load (file corruption, permission denied, etc.).</summary>
    bool LoadFailed { get; }
    /// <summary>Error message if LoadFailed is true, null otherwise.</summary>
    string? LoadError { get; }
}
