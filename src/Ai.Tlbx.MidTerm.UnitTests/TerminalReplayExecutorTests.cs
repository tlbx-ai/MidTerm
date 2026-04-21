using System.Text;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class TerminalReplayExecutorTests
{
    [Fact]
    public async Task ExecuteAsync_ReplaysTextAndImagesInOrderBeforeSubmitting()
    {
        var sentInputs = new List<string>();
        var imagePastes = new List<(string Path, string? MimeType)>();
        var delays = new List<int>();

        await TerminalReplayExecutor.ExecuteAsync(
            [
                new LensTerminalReplayStep
                {
                    Kind = "text",
                    Text = "Test "
                },
                new LensTerminalReplayStep
                {
                    Kind = "image",
                    Path = "Q:/repo/.midterm/uploads/image_1.png",
                    MimeType = "image/png"
                },
                new LensTerminalReplayStep
                {
                    Kind = "text",
                    Text = " and another "
                },
                new LensTerminalReplayStep
                {
                    Kind = "image",
                    Path = "Q:/repo/.midterm/uploads/image_2.png",
                    MimeType = "image/png"
                }
            ],
            (data, _) =>
            {
                sentInputs.Add(Encoding.UTF8.GetString(data));
                return Task.CompletedTask;
            },
            (path, mimeType, _) =>
            {
                imagePastes.Add((path, mimeType));
                return Task.FromResult(true);
            },
            (delayMs, _) =>
            {
                delays.Add(delayMs);
                return Task.CompletedTask;
            },
            CancellationToken.None);

        Assert.Equal(["Test ", " and another ", "\r"], sentInputs);
        Assert.Equal(
            [
                ("Q:/repo/.midterm/uploads/image_1.png", "image/png"),
                ("Q:/repo/.midterm/uploads/image_2.png", "image/png")
            ],
            imagePastes);
        Assert.Equal(
            [TerminalReplayExecutor.ImageSettleDelayMs, TerminalReplayExecutor.ImageSettleDelayMs, TerminalReplayExecutor.SubmitDelayMs],
            delays);
    }

    [Fact]
    public async Task ExecuteAsync_FallsBackToQuotedPathWhenImagePasteFails()
    {
        var sentInputs = new List<string>();

        await TerminalReplayExecutor.ExecuteAsync(
            [
                new LensTerminalReplayStep
                {
                    Kind = "image",
                    Path = "Q:/repo/.midterm/uploads/image_1.png",
                    MimeType = "image/png"
                }
            ],
            (data, _) =>
            {
                sentInputs.Add(Encoding.UTF8.GetString(data));
                return Task.CompletedTask;
            },
            (_, _, _) => Task.FromResult(false),
            static (_, _) => Task.CompletedTask,
            CancellationToken.None);

        Assert.Equal(["\"Q:/repo/.midterm/uploads/image_1.png\"", "\r"], sentInputs);
    }

    [Fact]
    public async Task ExecuteAsync_WrapsTextFileContentInBracketedPasteWhenRequested()
    {
        var tempFile = Path.GetTempFileName();
        var sentInputs = new List<string>();

        try
        {
            await File.WriteAllTextAsync(tempFile, "alpha\nbeta");
            await TerminalReplayExecutor.ExecuteAsync(
                [
                    new LensTerminalReplayStep
                    {
                        Kind = "textFile",
                        Path = tempFile,
                        UseBracketedPaste = true
                    }
                ],
                (data, _) =>
                {
                    sentInputs.Add(Encoding.UTF8.GetString(data));
                    return Task.CompletedTask;
                },
                (_, _, _) => Task.FromResult(false),
                static (_, _) => Task.CompletedTask,
                CancellationToken.None);
        }
        finally
        {
            File.Delete(tempFile);
        }

        Assert.Equal(["\u001b[200~alpha\nbeta\u001b[201~", "\r"], sentInputs);
    }
}
