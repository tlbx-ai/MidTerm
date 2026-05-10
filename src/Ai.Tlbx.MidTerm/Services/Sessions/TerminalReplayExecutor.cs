using System.Text;
using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

internal static class TerminalReplayExecutor
{
    internal const int ImageSettleDelayMs = 200;
    internal const int SubmitDelayMs = 200;

    public static async Task ExecuteAsync(
        IReadOnlyList<AppServerControlTerminalReplayStep> steps,
        Func<byte[], CancellationToken, Task> sendInputAsync,
        Func<string, string?, CancellationToken, Task<bool>> pasteImageAsync,
        Func<int, CancellationToken, Task> delayAsync,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(steps);
        ArgumentNullException.ThrowIfNull(sendInputAsync);
        ArgumentNullException.ThrowIfNull(pasteImageAsync);
        ArgumentNullException.ThrowIfNull(delayAsync);

        var sentAnyContent = false;
        foreach (var step in steps)
        {
            if (step is null)
            {
                continue;
            }

            switch (step.Kind)
            {
                case "text":
                    if (string.IsNullOrEmpty(step.Text))
                    {
                        continue;
                    }

                    await sendInputAsync(
                        EncodeText(step.Text, step.UseBracketedPaste),
                        cancellationToken).ConfigureAwait(false);
                    sentAnyContent = true;
                    break;
                case "filePath":
                    if (string.IsNullOrWhiteSpace(step.Path))
                    {
                        continue;
                    }

                    await sendInputAsync(
                        Encoding.UTF8.GetBytes(QuoteFilePath(step.Path)),
                        cancellationToken).ConfigureAwait(false);
                    sentAnyContent = true;
                    break;
                case "textFile":
                    if (string.IsNullOrWhiteSpace(step.Path))
                    {
                        continue;
                    }

                    if (File.Exists(step.Path))
                    {
                        var content = await File.ReadAllTextAsync(step.Path, cancellationToken).ConfigureAwait(false);
                        if (!string.IsNullOrEmpty(content))
                        {
                            await sendInputAsync(
                                EncodeText(content, step.UseBracketedPaste),
                                cancellationToken).ConfigureAwait(false);
                            sentAnyContent = true;
                        }
                    }
                    else
                    {
                        await sendInputAsync(
                            Encoding.UTF8.GetBytes(QuoteFilePath(step.Path)),
                            cancellationToken).ConfigureAwait(false);
                        sentAnyContent = true;
                    }
                    break;
                case "image":
                    if (string.IsNullOrWhiteSpace(step.Path))
                    {
                        continue;
                    }

                    if (await pasteImageAsync(step.Path, step.MimeType, cancellationToken).ConfigureAwait(false))
                    {
                        sentAnyContent = true;
                        await delayAsync(ImageSettleDelayMs, cancellationToken).ConfigureAwait(false);
                    }
                    else
                    {
                        await sendInputAsync(
                            Encoding.UTF8.GetBytes(QuoteFilePath(step.Path)),
                            cancellationToken).ConfigureAwait(false);
                        sentAnyContent = true;
                    }
                    break;
            }
        }

        if (!sentAnyContent)
        {
            return;
        }

        await delayAsync(SubmitDelayMs, cancellationToken).ConfigureAwait(false);
        await sendInputAsync([(byte)'\r'], cancellationToken).ConfigureAwait(false);
    }

    private static string QuoteFilePath(string path)
    {
        return "\"" + path + "\"";
    }

    private static byte[] EncodeText(string text, bool useBracketedPaste)
    {
        if (!useBracketedPaste)
        {
            return Encoding.UTF8.GetBytes(text);
        }

        return Encoding.UTF8.GetBytes($"\u001b[200~{text}\u001b[201~");
    }
}
