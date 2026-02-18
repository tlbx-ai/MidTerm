using System.Reflection;
using Microsoft.Extensions.FileProviders;

namespace Ai.Tlbx.MidTerm.Services.StaticFiles;

internal sealed class EmbeddedFileInfo : IFileInfo
{
    private readonly Assembly _assembly;
    private readonly string _resourceName;

    public EmbeddedFileInfo(Assembly assembly, string resourceName, string name, long length, DateTimeOffset lastModified)
    {
        _assembly = assembly;
        _resourceName = resourceName;
        Name = name;
        Length = length;
        LastModified = lastModified;
    }

    public bool Exists => true;
    public long Length { get; }
    public string? PhysicalPath => null;
    public string Name { get; }
    public DateTimeOffset LastModified { get; }
    public bool IsDirectory => false;

    public Stream CreateReadStream()
    {
        return _assembly.GetManifestResourceStream(_resourceName)
               ?? throw new FileNotFoundException($"Resource not found: {_resourceName}");
    }
}
