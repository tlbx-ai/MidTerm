using System.Globalization;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Raised when an Action Graph mutation was based on a stale entity or graph revision.
/// The caller must reload the current state and intentionally reconcile its mutation.
/// </summary>
public sealed class ActionGraphConflictException(
    string entity,
    int expectedRevision,
    int currentRevision)
    : Exception(
        string.Create(
            CultureInfo.InvariantCulture,
            $"Action Graph {entity} changed concurrently: expected revision {expectedRevision}, current revision {currentRevision}."))
{
    public string Entity { get; } = entity;
    public int ExpectedRevision { get; } = expectedRevision;
    public int CurrentRevision { get; } = currentRevision;
}
