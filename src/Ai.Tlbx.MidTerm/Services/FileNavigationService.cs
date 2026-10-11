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
        return new FileNavigationResponse
        {
            Path = fullPath,
            ParentPath = parent,
            Exists = File.Exists(fullPath) || Directory.Exists(fullPath),
            IsDirectory = Directory.Exists(fullPath)
        };
    }
}
