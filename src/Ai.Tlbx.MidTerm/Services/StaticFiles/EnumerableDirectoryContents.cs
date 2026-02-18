using Microsoft.Extensions.FileProviders;

namespace Ai.Tlbx.MidTerm.Services.StaticFiles;

internal sealed class EnumerableDirectoryContents : IDirectoryContents
{
    private readonly IReadOnlyList<IFileInfo> _files;

    public EnumerableDirectoryContents(IReadOnlyList<IFileInfo> files)
    {
        _files = files;
    }

    public bool Exists => true;

    public IEnumerator<IFileInfo> GetEnumerator() => _files.GetEnumerator();
    System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
}
