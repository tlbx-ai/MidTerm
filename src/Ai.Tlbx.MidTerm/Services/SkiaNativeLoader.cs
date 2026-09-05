using System.Runtime.InteropServices;
using System.Security.Cryptography;
using SkiaSharp;

namespace Ai.Tlbx.MidTerm.Services;

// Release archives and the updater carry mt alone. Extract the embedded RID-specific
// codec before its first P/Invoke; ordinary JIT builds use NuGet's native assets.
internal static class SkiaNativeLoader
{
    private static readonly Lock Sync = new();
    private static bool _initialized;

    internal static void EnsureLoaded(string settingsDirectory)
    {
        lock (Sync)
        {
            if (_initialized) return;
            var fileName = OperatingSystem.IsWindows() ? "libSkiaSharp.dll"
                : OperatingSystem.IsMacOS() ? "libSkiaSharp.dylib" : "libSkiaSharp.so";
            using var resource = typeof(SkiaNativeLoader).Assembly.GetManifestResourceStream($"tlbx.native.{fileName}");
            if (resource is not null)
            {
                // Content-addressing lets running releases coexist without replacing a
                // loaded DLL, including after updates with unchanged file size.
                var hash = Convert.ToHexStringLower(SHA256.HashData(resource));
                resource.Position = 0;
                var directory = Path.Combine(settingsDirectory, "native", "skia", hash);
                Directory.CreateDirectory(directory);
                var path = Path.Combine(directory, fileName);
                if (!File.Exists(path))
                {
                    var temporary = path + $".{Guid.NewGuid():N}.tmp";
                    try
                    {
                        using (var file = File.Create(temporary)) resource.CopyTo(file);
                        try { File.Move(temporary, path); }
                        catch (IOException) when (File.Exists(path)) { } // Concurrent extraction of the same resource.
                    }
                    finally
                    {
                        if (File.Exists(temporary)) File.Delete(temporary);
                    }
                }
                var handle = NativeLibrary.Load(path);
                NativeLibrary.SetDllImportResolver(typeof(SKBitmap).Assembly,
                    (name, _, _) => name == "libSkiaSharp" ? handle : IntPtr.Zero);
            }
            _initialized = true;
        }
    }
}
