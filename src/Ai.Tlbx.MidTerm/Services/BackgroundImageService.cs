using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models.System;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class BackgroundImageService
{
    private static readonly HashSet<string> AllowedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png",
        ".jpg",
        ".jpeg",
        ".webp"
    };

    private static readonly HashSet<string> AllowedContentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png",
        "image/jpeg",
        "image/webp"
    };

    private const long MaxUploadBytes = 10 * 1024 * 1024;
    private const int MinimumBackgroundImageTransparency = 50;
    // The filename records the encoding policy so older installations migrate once.
    private const string NormalizedFileName = "app-background-v2.webp";
    // Bound peak decode memory across simultaneous uploads and serialize replacements.
    private static readonly SemaphoreSlim UploadLock = new(1, 1);
    private readonly SettingsService _settingsService;
    private string? _failedMigrationPath;

    public BackgroundImageService(SettingsService settingsService)
    {
        _settingsService = settingsService;
        SkiaNativeLoader.EnsureLoaded(settingsService.SettingsDirectory);
    }

    public string GetDirectory()
    {
        return LogPaths.GetBackgroundDirectory(_settingsService.SettingsDirectory);
    }

    internal string GetLegacyDirectory()
    {
        var isWindowsService = _settingsService.IsRunningAsService && OperatingSystem.IsWindows();
        var isUnixService = _settingsService.IsRunningAsService && !OperatingSystem.IsWindows();
        return LogPaths.GetLegacyBackgroundDirectory(isWindowsService, isUnixService);
    }

    public string? GetCurrentImagePath(MidTermSettings settings)
    {
        if (string.IsNullOrWhiteSpace(settings.BackgroundImageFileName))
        {
            return null;
        }

        var path = Path.Combine(GetDirectory(), settings.BackgroundImageFileName);
        if (File.Exists(path))
        {
            return path;
        }

        var legacyPath = Path.Combine(GetLegacyDirectory(), settings.BackgroundImageFileName);
        return File.Exists(legacyPath) ? legacyPath : null;
    }

    public BackgroundImageInfoResponse GetInfo(MidTermSettings settings)
    {
        var path = GetCurrentImagePath(settings);
        return new BackgroundImageInfoResponse
        {
            HasImage = path is not null,
            FileName = path is not null ? Path.GetFileName(path) : null,
            Revision = settings.BackgroundImageRevision
        };
    }

    public async Task<string?> GetNormalizedImagePathAsync()
    {
        await UploadLock.WaitAsync();
        try
        {
            var settings = _settingsService.Load();
            var path = GetCurrentImagePath(settings);
            if (path is null || settings.BackgroundImageFileName == NormalizedFileName)
            {
                return path;
            }

            // Do not repeatedly decode a broken old image on every browser request.
            // Keep the source intact; replacing the wallpaper or restarting permits recovery.
            if (path == _failedMigrationPath)
            {
                return null;
            }

            try
            {
                if (new FileInfo(path).Length > MaxUploadBytes)
                {
                    throw new ArgumentException("Stored background image exceeds the 10 MB limit.");
                }
                var webp = BackgroundImageEncoder.Encode(await File.ReadAllBytesAsync(path));
                await StoreNormalizedAsync(webp, settings);
                return GetCurrentImagePath(settings);
            }
            catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException)
            {
                _failedMigrationPath = path;
                Log.Warn(() => $"Could not normalize stored background image; original retained and background not served: {ex.Message}");
                return null;
            }
        }
        finally
        {
            UploadLock.Release();
        }
    }

    public async Task<BackgroundImageInfoResponse> SaveAsync(IFormFile file)
    {
        if (file is null || file.Length == 0)
        {
            throw new ArgumentException("No file provided.");
        }

        if (file.Length > MaxUploadBytes)
        {
            throw new ArgumentException("Background image is too large. Maximum size is 10 MB.");
        }

        var extension = Path.GetExtension(file.FileName);
        if (string.IsNullOrWhiteSpace(extension) || !AllowedExtensions.Contains(extension))
        {
            throw new ArgumentException("Only PNG, JPG and WebP images are supported.");
        }

        if (!string.IsNullOrWhiteSpace(file.ContentType) && !AllowedContentTypes.Contains(file.ContentType))
        {
            throw new ArgumentException("Only PNG, JPG and WebP images are supported.");
        }

        await UploadLock.WaitAsync();
        try
        {
            return await SaveNormalizedAsync(file);
        }
        finally
        {
            UploadLock.Release();
        }
    }

    private async Task<BackgroundImageInfoResponse> SaveNormalizedAsync(IFormFile file)
    {
        await using var upload = file.OpenReadStream();
        using var input = new MemoryStream();
        await upload.CopyToAsync(input);
        var webp = BackgroundImageEncoder.Encode(input.ToArray());
        var settings = _settingsService.Load();
        settings.BackgroundImageEnabled = true;
        EnsureMinimumBackgroundImageTransparency(settings);
        await StoreNormalizedAsync(webp, settings);
        _failedMigrationPath = null;
        return GetInfo(settings);
    }

    private async Task StoreNormalizedAsync(byte[] webp, MidTermSettings settings)
    {
        var previousPath = GetCurrentImagePath(settings);
        var directory = GetDirectory();
        Directory.CreateDirectory(directory);

        var tempPath = Path.Combine(directory, $"{Guid.NewGuid():N}.tmp");
        var finalPath = Path.Combine(directory, NormalizedFileName);

        try
        {
            await File.WriteAllBytesAsync(tempPath, webp);
            File.Move(tempPath, finalPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(tempPath))
            {
                File.Delete(tempPath);
            }
        }

        settings.BackgroundImageFileName = NormalizedFileName;
        settings.BackgroundImageRevision = Math.Max(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), settings.BackgroundImageRevision + 1);
        _settingsService.Save(settings);

        // Switch settings only after the new file exists, then discard superseded local files.
        var superseded = Directory.EnumerateFiles(directory, "app-background.*");
        if (previousPath is not null && string.Equals(Path.GetDirectoryName(previousPath), directory, StringComparison.OrdinalIgnoreCase))
        {
            superseded = superseded.Append(previousPath).Distinct(StringComparer.OrdinalIgnoreCase);
        }
        foreach (var existingPath in superseded)
        {
            if (!string.Equals(existingPath, finalPath, StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    File.Delete(existingPath);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    Log.Warn(() => $"Normalized background saved; could not remove superseded image: {ex.Message}");
                }
            }
        }
    }

    public async Task<BackgroundImageInfoResponse> DeleteAsync()
    {
        await UploadLock.WaitAsync();
        try
        {
            return DeleteCurrentImage();
        }
        finally
        {
            UploadLock.Release();
        }
    }

    private BackgroundImageInfoResponse DeleteCurrentImage()
    {
        var settings = _settingsService.Load();
        var path = GetCurrentImagePath(settings);
        if (path is not null && File.Exists(path))
        {
            File.Delete(path);
        }

        settings.BackgroundImageFileName = null;
        settings.BackgroundImageEnabled = false;
        settings.BackgroundImageRevision = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        _settingsService.Save(settings);

        return GetInfo(settings);
    }

    private static void EnsureMinimumBackgroundImageTransparency(MidTermSettings settings)
    {
        settings.UiTransparency = Math.Max(settings.UiTransparency, MinimumBackgroundImageTransparency);
        settings.TerminalTransparency = Math.Max(settings.TerminalTransparency, MinimumBackgroundImageTransparency);
    }
}
