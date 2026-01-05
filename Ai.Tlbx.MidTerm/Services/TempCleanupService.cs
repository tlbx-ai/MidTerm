namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Service for cleaning up orphaned temporary files from crashed MidTerm instances.
/// Each instance only cleans its own temp path (service mode = SystemTemp, user mode = user temp).
/// </summary>
public sealed class TempCleanupService
{
    private const string DropsFolder = "mt-drops";
    private const string UpdatePrefix = "mt-update-";
    private const string LegacyDropsFolder = "mm-drops";
    private const string LegacyUpdatePrefix = "mm-update-";

    private static readonly TimeSpan OrphanAge = TimeSpan.FromHours(1);
    private static readonly TimeSpan MinAge = TimeSpan.FromSeconds(30);

    private readonly string _tempPath;
    private readonly ILogger<TempCleanupService> _logger;

    public TempCleanupService(ILogger<TempCleanupService> logger)
    {
        _tempPath = Path.GetTempPath();
        _logger = logger;
    }

    /// <summary>
    /// Clean orphaned temp files from previous crashed MT instances.
    /// Called on startup. Only cleans THIS process's temp path.
    /// </summary>
    public void CleanupOrphanedFiles()
    {
        var now = DateTime.UtcNow;
        var deleted = 0;
        var failed = 0;

        // 1. Clean legacy mm-drops folder (always orphaned - old naming)
        var legacyDrops = Path.Combine(_tempPath, LegacyDropsFolder);
        if (Directory.Exists(legacyDrops))
        {
            if (TryDeleteDirectory(legacyDrops))
            {
                deleted++;
            }
            else
            {
                failed++;
            }
        }

        // 2. Clean mt-drops session subdirectories
        var dropsFolder = Path.Combine(_tempPath, DropsFolder);
        if (Directory.Exists(dropsFolder))
        {
            try
            {
                foreach (var sessionDir in Directory.GetDirectories(dropsFolder))
                {
                    var age = now - Directory.GetCreationTimeUtc(sessionDir);
                    if (age > MinAge && age > OrphanAge)
                    {
                        if (TryDeleteDirectory(sessionDir))
                        {
                            deleted++;
                        }
                        else
                        {
                            failed++;
                        }
                    }
                }

                // Delete parent if empty
                if (Directory.Exists(dropsFolder) && !Directory.EnumerateFileSystemEntries(dropsFolder).Any())
                {
                    TryDeleteDirectory(dropsFolder);
                }
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Error enumerating {DropsFolder} directories", DropsFolder);
            }
        }

        // 3. Clean legacy mm-update-* folders
        CleanupUpdateFolders(LegacyUpdatePrefix, now, ref deleted, ref failed);

        // 4. Clean mt-update-* folders
        CleanupUpdateFolders(UpdatePrefix, now, ref deleted, ref failed);

        // 5. Clean orphaned update scripts
        CleanupUpdateScripts(now, ref deleted, ref failed);

        if (deleted > 0 || failed > 0)
        {
            _logger.LogInformation("Temp cleanup: deleted {Deleted} orphaned items, {Failed} failed", deleted, failed);
        }
    }

    /// <summary>
    /// Force cleanup of all MT temp files in this process's temp path.
    /// Called on shutdown.
    /// </summary>
    public void CleanupAllMidTermFiles()
    {
        var legacyDrops = Path.Combine(_tempPath, LegacyDropsFolder);
        if (Directory.Exists(legacyDrops))
        {
            TryDeleteDirectory(legacyDrops);
        }

        var dropsFolder = Path.Combine(_tempPath, DropsFolder);
        if (Directory.Exists(dropsFolder))
        {
            TryDeleteDirectory(dropsFolder);
        }

        try
        {
            foreach (var dir in Directory.GetDirectories(_tempPath, $"{UpdatePrefix}*"))
            {
                TryDeleteDirectory(dir);
            }

            foreach (var dir in Directory.GetDirectories(_tempPath, $"{LegacyUpdatePrefix}*"))
            {
                TryDeleteDirectory(dir);
            }
        }
        catch
        {
            // Best effort
        }
    }

    private void CleanupUpdateFolders(string prefix, DateTime now, ref int deleted, ref int failed)
    {
        try
        {
            foreach (var dir in Directory.GetDirectories(_tempPath, $"{prefix}*"))
            {
                var age = now - Directory.GetCreationTimeUtc(dir);
                if (age > MinAge && age > OrphanAge)
                {
                    if (TryDeleteDirectory(dir))
                    {
                        deleted++;
                    }
                    else
                    {
                        failed++;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Error enumerating {Prefix}* folders", prefix);
        }
    }

    private void CleanupUpdateScripts(DateTime now, ref int deleted, ref int failed)
    {
        var patterns = new[] { "mt-update-*.ps1", "mt-update-*.sh", "mm-update-*.ps1", "mm-update-*.sh" };
        foreach (var pattern in patterns)
        {
            try
            {
                foreach (var file in Directory.GetFiles(_tempPath, pattern))
                {
                    var age = now - File.GetCreationTimeUtc(file);
                    if (age > MinAge && age > OrphanAge)
                    {
                        try
                        {
                            File.Delete(file);
                            deleted++;
                        }
                        catch
                        {
                            failed++;
                        }
                    }
                }
            }
            catch
            {
                // Best effort
            }
        }
    }

    private bool TryDeleteDirectory(string path)
    {
        try
        {
            Directory.Delete(path, recursive: true);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Failed to delete orphaned directory: {Path}", path);
            return false;
        }
    }
}
