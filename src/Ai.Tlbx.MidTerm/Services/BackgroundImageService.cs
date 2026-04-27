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
        ".jpeg"
    };

    private static readonly HashSet<string> AllowedContentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png",
        "image/jpeg"
    };

    private const long MaxUploadBytes = 10 * 1024 * 1024;
    private const int MinimumBackgroundImageTransparency = 50;
    private readonly SettingsService _settingsService;

    public BackgroundImageService(SettingsService settingsService)
    {
        _settingsService = settingsService;
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
            throw new ArgumentException("Only PNG and JPG images are supported.");
        }

        if (!string.IsNullOrWhiteSpace(file.ContentType) && !AllowedContentTypes.Contains(file.ContentType))
        {
            throw new ArgumentException("Only PNG and JPG images are supported.");
        }

        var settings = _settingsService.Load();
        var directory = GetDirectory();
        Directory.CreateDirectory(directory);

        var normalizedExtension = extension.Equals(".jpeg", StringComparison.OrdinalIgnoreCase)
            ? ".jpg"
            : extension.ToLowerInvariant();
        var fileName = "app-background" + normalizedExtension;
        var tempPath = Path.Combine(directory, $"{Guid.NewGuid():N}.tmp");
        var finalPath = Path.Combine(directory, fileName);

        await using (var stream = File.Create(tempPath))
        {
            await file.CopyToAsync(stream);
        }

        foreach (var existingPath in Directory.EnumerateFiles(directory, "app-background.*"))
        {
            if (!string.Equals(existingPath, finalPath, StringComparison.OrdinalIgnoreCase))
            {
                File.Delete(existingPath);
            }
        }

        File.Move(tempPath, finalPath, overwrite: true);

        settings.BackgroundImageFileName = fileName;
        settings.BackgroundImageEnabled = true;
        settings.BackgroundImageRevision = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        EnsureMinimumBackgroundImageTransparency(settings);
        _settingsService.Save(settings);

        return GetInfo(settings);
    }

    public BackgroundImageInfoResponse Delete()
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
