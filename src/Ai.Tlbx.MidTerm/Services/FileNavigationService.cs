using Ai.Tlbx.MidTerm.Models.Files;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>Resolves directory hierarchy within the caller's existing path permissions.</summary>
public static class FileNavigationService
{
    public static FileNavigationResponse Describe(string path, Func<string, bool> isAccessible)
    {
        var fullPath = Path.GetFullPath(path);
        if (!isAccessible(fullPath) || !isAccessible(FileDocumentService.ResolvePath(fullPath)))
            throw new UnauthorizedAccessException();
        var parent = Directory.GetParent(fullPath)?.FullName;
        if (parent is not null && (!Directory.Exists(parent) || !isAccessible(parent) ||
            !isAccessible(FileDocumentService.ResolvePath(parent))))
            parent = null;
        var breadcrumbs = new List<FileNavigationLocation>();
        var current = Directory.Exists(fullPath) ? fullPath : parent;
        while (current is not null && Directory.Exists(current) && isAccessible(current) &&
            isAccessible(FileDocumentService.ResolvePath(current)))
        {
            breadcrumbs.Add(new FileNavigationLocation { Path = current, Name = LocationName(current) });
            current = Directory.GetParent(current)?.FullName;
        }
        breadcrumbs.Reverse();
        FileTreeEntry? file = null;
        if (File.Exists(fullPath))
        {
            var info = FileService.GetFileInfo(FileDocumentService.ResolvePath(fullPath));
            file = new FileTreeEntry { Name = Path.GetFileName(fullPath), FullPath = fullPath, IsDirectory = false,
                Size = info.Size, MimeType = info.MimeType, IsText = info.IsText };
        }
        return new FileNavigationResponse
        {
            Path = fullPath,
            ParentPath = parent,
            Exists = File.Exists(fullPath) || Directory.Exists(fullPath),
            IsDirectory = Directory.Exists(fullPath),
            Breadcrumbs = breadcrumbs.ToArray(),
            File = file
        };
    }

    public static string LocationName(string path) =>
        Directory.GetParent(path) is null ? path : Path.GetFileName(path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
}
