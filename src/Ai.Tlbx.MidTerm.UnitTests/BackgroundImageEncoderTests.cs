using System.Buffers.Binary;
using Ai.Tlbx.MidTerm.Services;
using StbImageSharp;
using StbImageWriteSharp;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class BackgroundImageEncoderTests
{
    internal static byte[] CreatePng(int width, int height, byte alpha = 255)
    {
        var pixels = new byte[width * height * 4];
        for (var i = 0; i < pixels.Length; i += 4)
        {
            pixels[i] = 240;
            pixels[i + 1] = 120;
            pixels[i + 2] = 60;
            pixels[i + 3] = alpha;
        }
        using var output = new MemoryStream();
        new ImageWriter().WritePng(pixels, width, height,
            StbImageWriteSharp.ColorComponents.RedGreenBlueAlpha, output);
        return output.ToArray();
    }

    [Theory]
    [InlineData(4096, 512, 2048, 256)]
    [InlineData(512, 4096, 256, 2048)]
    [InlineData(65, 33, 65, 33)]
    public void Encode_PreservesAspectRatioWithoutUpscaling(int width, int height, int expectedWidth, int expectedHeight)
    {
        var jpeg = BackgroundImageEncoder.Encode(CreatePng(width, height));
        Assert.Equal(255, jpeg[0]);
        Assert.Equal(216, jpeg[1]);
        var image = ImageResult.FromMemory(jpeg);
        Assert.Equal(expectedWidth, image.Width);
        Assert.Equal(expectedHeight, image.Height);
        // JPEG luminance DC quantizer: quality 85 scales the standard value 16 to 5.
        var dqt = jpeg.AsSpan().IndexOf(new byte[] { 255, 219 });
        Assert.True(dqt >= 0);
        Assert.Equal(5, jpeg[dqt + 5]);
    }

    [Theory]
    [InlineData(0, 0)]
    [InlineData(128, 120)]
    public void Encode_CompositesTransparencyOnBlack(byte alpha, int expectedRed)
    {
        var image = ImageResult.FromMemory(BackgroundImageEncoder.Encode(CreatePng(16, 16, alpha)),
            StbImageSharp.ColorComponents.RedGreenBlue);
        Assert.InRange(image.Data[0], expectedRed - 3, expectedRed + 3);
    }

    [Fact]
    public void Encode_RejectsExcessiveDimensionsBeforeDecodingPixels()
    {
        var png = CreatePng(1, 1);
        BinaryPrimitives.WriteInt32BigEndian(png.AsSpan(16), 100_000);
        BinaryPrimitives.WriteInt32BigEndian(png.AsSpan(20), 100_000);
        Assert.Throws<ArgumentException>(() => BackgroundImageEncoder.Encode(png));
    }

    [Fact]
    public void Encode_AppliesExifRotationAndRemovesMetadata()
    {
        var jpeg = BackgroundImageEncoder.Encode(CreatePng(32, 16));
        // APP1 / little-endian TIFF, IFD0 orientation = 6 (90 degrees clockwise).
        byte[] exif = [255, 225, 0, 34, 69, 120, 105, 102, 0, 0,
            73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
        byte[] withExif = [.. jpeg.AsSpan(0, 2), .. exif, .. jpeg.AsSpan(2)];
        var normalized = BackgroundImageEncoder.Encode(withExif);
        var image = ImageResult.FromMemory(normalized);
        Assert.Equal(16, image.Width);
        Assert.Equal(32, image.Height);
        Assert.Equal(-1, normalized.AsSpan().IndexOf("Exif"u8));
    }
}
