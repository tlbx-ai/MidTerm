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

        var first = service.TryRegisterClient("c1", "session-a", "user1", "preview-a", _ => { });
        var duplicate = service.TryRegisterClient("c2", "session-a", "user1", "preview-a", _ => { });

        Assert.True(first);
        Assert.False(duplicate);
    }

    [Fact]
    public async Task ExecuteCommandAsync_WithMatchingSession_RoutesToCorrectPreview()
    {
        var service = new BrowserCommandService();
        BrowserWsMessage? captured = null;

        Assert.True(service.TryRegisterClient("c1", "session-a", "user1", "preview-a", _ => { }));
        Assert.True(service.TryRegisterClient("c2", "session-b", "user2", "preview-b", msg =>
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
        Assert.Equal("user2", captured.PreviewName);
        Assert.Equal("preview-b", captured.PreviewId);
    }

    [Fact]
    public async Task ExecuteCommandAsync_WithMultipleClientsAndNoSession_ReturnsHelpfulError()
    {
        var service = new BrowserCommandService();
        Assert.True(service.TryRegisterClient("c1", "session-a", "user1", "preview-a", _ => { }, browserId: "browser-a"));
        Assert.True(service.TryRegisterClient("c2", "session-b", "user2", "preview-b", _ => { }, browserId: "browser-b"));

        var result = await service.ExecuteCommandAsync(new BrowserCommandRequest
        {
            Command = "url"
        }, CancellationToken.None);

        Assert.False(result.Success);
        Assert.Contains("--session", result.Error ?? "", StringComparison.Ordinal);
    }

    [Fact]
    public async Task ExecuteCommandAsync_WithSameBrowserDuplicates_PrefersNewestPreviewClient()
    {
        var service = new BrowserCommandService();
        BrowserWsMessage? captured = null;

        Assert.True(service.TryRegisterClient("c1", null, null, null, _ => { }, browserId: "browser-a"));
        Assert.True(service.TryRegisterClient("c2", "session-a", "user1", "preview-a", msg =>
        {
            captured = msg;
            service.ReceiveResult(new BrowserWsResult
            {
                Id = msg.Id,
                Success = true,
                Result = "ok",
                PreviewId = "preview-a"
            });
        }, browserId: "browser-a"));

        var result = await service.ExecuteCommandAsync(new BrowserCommandRequest
        {
            Command = "url"
        }, CancellationToken.None);

        Assert.True(result.Success);
        Assert.Equal("ok", result.Result);
        Assert.NotNull(captured);
        Assert.Equal("preview-a", captured!.PreviewId);
    }

    [Fact]
    public async Task UnregisterClient_CancelsOnlyPendingCommandsForThatPreview()
    {
        var service = new BrowserCommandService();
        BrowserWsMessage? keptMessage = null;

        Assert.True(service.TryRegisterClient("c1", "session-a", "user1", "preview-a", _ => { }));
        Assert.True(service.TryRegisterClient("c2", "session-b", "user2", "preview-b", msg =>
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

    [Fact]
    public async Task ExecuteCommandAsync_WithMatchingSessionAndPreviewName_RoutesToCorrectNamedPreview()
    {
        var service = new BrowserCommandService();
        BrowserWsMessage? captured = null;

        Assert.True(service.TryRegisterClient("c1", "session-a", "user1", "preview-a", _ => { }));
        Assert.True(service.TryRegisterClient("c2", "session-a", "user2", "preview-b", msg =>
        {
            captured = msg;
            service.ReceiveResult(new BrowserWsResult
            {
                Id = msg.Id,
                Success = true,
                Result = "user2-ok",
                PreviewId = "preview-b",
                PreviewName = "user2"
            });
        }));

        var result = await service.ExecuteCommandAsync(new BrowserCommandRequest
        {
            Command = "url",
            SessionId = "session-a",
            PreviewName = "user2"
        }, CancellationToken.None);

        Assert.True(result.Success);
        Assert.Equal("user2-ok", result.Result);
        Assert.NotNull(captured);
        Assert.Equal("session-a", captured!.SessionId);
        Assert.Equal("user2", captured.PreviewName);
        Assert.Equal("preview-b", captured.PreviewId);
    }

    [Fact]
    public void GetStatus_WithScopedPreview_ReturnsOnlyMatchingClient()
    {
        var service = new BrowserCommandService();

        Assert.True(service.TryRegisterClient("c1", "session-a", "default", "preview-a", _ => { }));
        Assert.True(service.TryRegisterClient("c2", "session-a", "codex1", "preview-b", _ => { }));
        Assert.True(service.TryRegisterClient("c3", "session-b", "codex1", "preview-c", _ => { }));

        var status = service.GetStatus(
            "https://localhost:5001/teacher?dev=1",
            sessionId: "session-a",
            previewName: "codex1");

        Assert.True(status.Connected);
        Assert.Equal(1, status.ConnectedClientCount);
        Assert.NotNull(status.DefaultClient);
        Assert.Equal("session-a", status.DefaultClient!.SessionId);
        Assert.Equal("codex1", status.DefaultClient.PreviewName);
        Assert.Equal("preview-b", status.DefaultClient.PreviewId);
        Assert.Single(status.Clients);
    }

    [Fact]
    public void GetStatusText_WithScopedPreviewAndNoMatch_ReturnsHelpfulDisconnectedMessage()
    {
        var service = new BrowserCommandService();
        Assert.True(service.TryRegisterClient("c1", "session-a", "default", "preview-a", _ => { }));

        var status = service.GetStatusText(
            "https://localhost:5001/teacher?dev=1",
            sessionId: "session-a",
            previewName: "codex1");

        Assert.Contains("disconnected", status, StringComparison.Ordinal);
        Assert.Contains("preview 'codex1' in session 'session-a'", status, StringComparison.Ordinal);
    }
}
