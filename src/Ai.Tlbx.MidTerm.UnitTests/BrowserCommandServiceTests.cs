using Ai.Tlbx.MidTerm.Models.Browser;
using Ai.Tlbx.MidTerm.Services.Browser;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class BrowserCommandServiceTests
{
    [Fact]
    public void TryRegisterClient_RejectsDuplicatePreviewIds()
    {
        var service = new BrowserCommandService();

        var first = service.TryRegisterClient("c1", "session-a", "preview-a", _ => { });
        var duplicate = service.TryRegisterClient("c2", "session-a", "preview-a", _ => { });

        Assert.True(first);
        Assert.False(duplicate);
    }

    [Fact]
    public async Task ExecuteCommandAsync_WithMatchingSession_RoutesToCorrectPreview()
    {
        var service = new BrowserCommandService();
        BrowserWsMessage? captured = null;

        Assert.True(service.TryRegisterClient("c1", "session-a", "preview-a", _ => { }));
        Assert.True(service.TryRegisterClient("c2", "session-b", "preview-b", msg =>
        {
            captured = msg;
            service.ReceiveResult(new BrowserWsResult
            {
                Id = msg.Id,
                Success = true,
                Result = "ok",
                PreviewId = "preview-b"
            });
        }));

        var result = await service.ExecuteCommandAsync(new BrowserCommandRequest
        {
            Command = "url",
            SessionId = "session-b"
        }, CancellationToken.None);

        Assert.True(result.Success);
        Assert.Equal("ok", result.Result);
        Assert.NotNull(captured);
        Assert.Equal("session-b", captured!.SessionId);
        Assert.Equal("preview-b", captured.PreviewId);
    }

    [Fact]
    public async Task ExecuteCommandAsync_WithMultipleClientsAndNoSession_ReturnsHelpfulError()
    {
        var service = new BrowserCommandService();
        Assert.True(service.TryRegisterClient("c1", "session-a", "preview-a", _ => { }));
        Assert.True(service.TryRegisterClient("c2", "session-b", "preview-b", _ => { }));

        var result = await service.ExecuteCommandAsync(new BrowserCommandRequest
        {
            Command = "url"
        }, CancellationToken.None);

        Assert.False(result.Success);
        Assert.Contains("--session", result.Error ?? "", StringComparison.Ordinal);
    }

    [Fact]
    public async Task UnregisterClient_CancelsOnlyPendingCommandsForThatPreview()
    {
        var service = new BrowserCommandService();
        BrowserWsMessage? keptMessage = null;

        Assert.True(service.TryRegisterClient("c1", "session-a", "preview-a", _ => { }));
        Assert.True(service.TryRegisterClient("c2", "session-b", "preview-b", msg =>
        {
            keptMessage = msg;
        }));

        var disconnectedTask = service.ExecuteCommandAsync(new BrowserCommandRequest
        {
            Command = "url",
            SessionId = "session-a"
        }, CancellationToken.None);

        var keptTask = service.ExecuteCommandAsync(new BrowserCommandRequest
        {
            Command = "url",
            SessionId = "session-b"
        }, CancellationToken.None);

        service.UnregisterClient("c1");
        var disconnected = await disconnectedTask;

        Assert.False(disconnected.Success);
        Assert.Equal("Browser disconnected.", disconnected.Error);

        Assert.NotNull(keptMessage);
        service.ReceiveResult(new BrowserWsResult
        {
            Id = keptMessage!.Id,
            Success = true,
            Result = "still-connected",
            PreviewId = "preview-b"
        });

        var kept = await keptTask;
        Assert.True(kept.Success);
        Assert.Equal("still-connected", kept.Result);
    }
}
