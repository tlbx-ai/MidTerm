using MetadataExtractor;
using MetadataExtractor.Formats.Exif;
using StbImageResizeSharp;
using StbImageSharp;
using StbImageWriteSharp;

namespace Ai.Tlbx.MidTerm.Services;

internal static class BackgroundImageEncoder
{
    internal const int MaxEdge = 2048;
    internal const int JpegQuality = 85;
    private const long MaxPixels = 64_000_000;

    internal static byte[] Encode(byte[] upload)
    {
        // Validate the real format, not just the browser's filename/MIME type.
        if (!(upload.AsSpan().StartsWith(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }) ||
              upload.AsSpan().StartsWith(new byte[] { 255, 216, 255 })))
        {
            throw new ArgumentException("Only valid PNG and JPG images are supported.");
        }

        using var input = new MemoryStream(upload, writable: false);
        ImageResult image;
        int orientation;
        try
        {
            var info = ImageInfo.FromStream(input);
            if (info is not { Width: > 0, Height: > 0 } dimensions ||
                (long)dimensions.Width * dimensions.Height > MaxPixels ||
                dimensions.Width > 32768 || dimensions.Height > 32768)
            {
                throw new ArgumentException("Background image must contain at most 64 megapixels and be no larger than 32768 pixels per side.");
            }

            input.Position = 0;
            orientation = ImageMetadataReader.ReadMetadata(input)
                .OfType<ExifIfd0Directory>()
                .Select(directory => directory.TryGetInt32(ExifDirectoryBase.TagOrientation, out var value) ? value : 1)
                .FirstOrDefault(1);
            input.Position = 0;
            image = ImageResult.FromStream(input, StbImageSharp.ColorComponents.RedGreenBlueAlpha);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            throw new ArgumentException("Cannot read background image. Use a valid PNG or JPG of at most 64 megapixels and 32768 pixels per side.", ex);
        }

        // JPEG has no alpha. Composite on black before filtering to prevent transparent
        // pixels' hidden RGB from bleeding into visible edges.
        for (var i = 0; i < image.Data.Length; i += 4)
        {
            var alpha = image.Data[i + 3];
            for (var channel = 0; channel < 3; channel++)
            {
                image.Data[i + channel] = (byte)((image.Data[i + channel] * alpha + 127) / 255);
            }
            image.Data[i + 3] = 255;
        }

        var scale = Math.Min(1d, (double)MaxEdge / Math.Max(image.Width, image.Height));
        var width = Math.Max(1, (int)Math.Round(image.Width * scale));
        var height = Math.Max(1, (int)Math.Round(image.Height * scale));
        var pixels = image.Data;
        if (width != image.Width || height != image.Height)
        {
            pixels = new byte[width * height * 4];
            if (StbImageResize.stbir_resize_uint8(image.Data, image.Width, image.Height, image.Width * 4,
                    pixels, width, height, width * 4, 4) == 0)
            {
                throw new ArgumentException("Cannot resize background image.");
            }
        }

        // Rotate/mirror the small result; EXIF is then deliberately omitted from the JPEG.
        if (orientation is >= 2 and <= 8)
        {
            var rotatedWidth = orientation >= 5 ? height : width;
            var rotatedHeight = orientation >= 5 ? width : height;
            var rotated = new byte[pixels.Length];
            for (var y = 0; y < height; y++)
            {
                for (var x = 0; x < width; x++)
                {
                    var (dx, dy) = orientation switch
                    {
                        2 => (width - 1 - x, y),
                        3 => (width - 1 - x, height - 1 - y),
                        4 => (x, height - 1 - y),
                        5 => (y, x),
                        6 => (height - 1 - y, x),
                        7 => (height - 1 - y, width - 1 - x),
                        _ => (y, width - 1 - x)
                    };
                    pixels.AsSpan((y * width + x) * 4, 4).CopyTo(rotated.AsSpan((dy * rotatedWidth + dx) * 4, 4));
                }
            }
            pixels = rotated;
            width = rotatedWidth;
            height = rotatedHeight;
        }

        using var output = new MemoryStream();
        new ImageWriter().WriteJpg(pixels, width, height,
            StbImageWriteSharp.ColorComponents.RedGreenBlueAlpha, output, JpegQuality);
        return output.ToArray();
    }
}
