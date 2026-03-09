using System.Net.WebSockets;
using System.Net.Http.Json;
using System.Text;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Services.WebSockets;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

using Ai.Tlbx.MidTerm.Models.Auth;
using Ai.Tlbx.MidTerm.Models.Certificates;
using Ai.Tlbx.MidTerm.Models.Files;
using Ai.Tlbx.MidTerm.Models.History;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Models.System;
using Ai.Tlbx.MidTerm.Models.WebPreview;
namespace Ai.Tlbx.MidTerm.Tests;

public class IntegrationTests : IClassFixture<WebApplicationFactory<Program>>, IAsyncLifetime
{
    private readonly WebApplicationFactory<Program> _factory;
    private readonly HttpClient _client;
    private readonly List<WebSocket> _webSockets = [];

    public IntegrationTests(WebApplicationFactory<Program> factory)
    {
        _factory = factory;
        _client = _factory.CreateClient();
    }

    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync()
    {
        foreach (var ws in _webSockets)
        {
            if (ws.State == WebSocketState.Open)
            {
                try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None); }
                catch { }
            }
            ws.Dispose();
        }

        _client.Dispose();
    }

    [Fact]
    public async Task Api_GetVersion_ReturnsVersion()
    {
        var response = await _client.GetAsync("/api/version");

        response.EnsureSuccessStatusCode();
        var version = await response.Content.ReadAsStringAsync();

        Assert.NotEmpty(version);
    }

    [Fact]
    public async Task WebSocket_Mux_ReceivesInitFrame()
    {
        var ws = await ConnectWebSocketAsync("/ws/mux");

        var buffer = new byte[1024];
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var result = await ws.ReceiveAsync(buffer, cts.Token);

        Assert.Equal(WebSocketMessageType.Binary, result.MessageType);
        Assert.True(result.Count >= MuxProtocol.HeaderSize);
        Assert.Equal(0xFF, buffer[0]);
    }

    [Fact]
    public async Task WebSocket_State_ReceivesInitialSessionList()
    {
        var ws = await ConnectWebSocketAsync("/ws/state");

        var buffer = new byte[8192];
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var result = await ws.ReceiveAsync(buffer, cts.Token);

        Assert.Equal(WebSocketMessageType.Text, result.MessageType);
        var json = Encoding.UTF8.GetString(buffer, 0, result.Count);

        var state = System.Text.Json.JsonSerializer.Deserialize<StateUpdate>(json, AppJsonContext.Default.StateUpdate);
        Assert.NotNull(state);
        Assert.NotNull(state.Sessions);
        Assert.NotNull(state.Sessions.Sessions);
    }

    [Fact]
    public async Task WebPreview_CookieBridge_SetGetDelete_Works()
    {
        var targetRes = await _client.PutAsJsonAsync("/api/webpreview/target", new WebPreviewTargetRequest
        {
            Url = "https://example.com"
        }, AppJsonContext.Default.WebPreviewTargetRequest);
        targetRes.EnsureSuccessStatusCode();

        var setRes = await _client.PostAsJsonAsync("/api/webpreview/cookies", new WebPreviewCookieSetRequest
        {
            Raw = "theme=dark; Path=/"
        }, AppJsonContext.Default.WebPreviewCookieSetRequest);
        setRes.EnsureSuccessStatusCode();

        var getRes = await _client.GetAsync("/api/webpreview/cookies");
        getRes.EnsureSuccessStatusCode();
        var cookies = await getRes.Content.ReadFromJsonAsync(
            AppJsonContext.Default.WebPreviewCookiesResponse);
        Assert.NotNull(cookies);
        Assert.Contains("theme=dark", cookies.Header, StringComparison.Ordinal);

        var delRes = await _client.DeleteAsync("/api/webpreview/cookies?name=theme");
        delRes.EnsureSuccessStatusCode();

        var afterDeleteRes = await _client.GetAsync("/api/webpreview/cookies");
        afterDeleteRes.EnsureSuccessStatusCode();
        var afterDelete = await afterDeleteRes.Content.ReadFromJsonAsync(
            AppJsonContext.Default.WebPreviewCookiesResponse);
        Assert.NotNull(afterDelete);
        Assert.DoesNotContain("theme=dark", afterDelete.Header, StringComparison.Ordinal);
    }

    [Fact]
    public async Task WebPreview_HardReload_ClearsCookieJar()
    {
        var targetRes = await _client.PutAsJsonAsync("/api/webpreview/target", new WebPreviewTargetRequest
        {
            Url = "https://example.com"
        }, AppJsonContext.Default.WebPreviewTargetRequest);
        targetRes.EnsureSuccessStatusCode();

        var setRes = await _client.PostAsJsonAsync("/api/webpreview/cookies", new WebPreviewCookieSetRequest
        {
            Raw = "session=abc123; Path=/"
        }, AppJsonContext.Default.WebPreviewCookieSetRequest);
        setRes.EnsureSuccessStatusCode();

        var reloadRes = await _client.PostAsJsonAsync("/api/webpreview/reload", new WebPreviewReloadRequest
        {
            Mode = "hard"
        }, AppJsonContext.Default.WebPreviewReloadRequest);
        reloadRes.EnsureSuccessStatusCode();

        var getRes = await _client.GetAsync("/api/webpreview/cookies");
        getRes.EnsureSuccessStatusCode();
        var cookies = await getRes.Content.ReadFromJsonAsync(
            AppJsonContext.Default.WebPreviewCookiesResponse);
        Assert.NotNull(cookies);
        Assert.True(string.IsNullOrEmpty(cookies.Header));
    }

    [Fact]
    public async Task WebPreview_CookieBridge_HidesHttpOnlyCookies()
    {
        var targetRes = await _client.PutAsJsonAsync("/api/webpreview/target", new WebPreviewTargetRequest
        {
            Url = "https://example.com"
        }, AppJsonContext.Default.WebPreviewTargetRequest);
        targetRes.EnsureSuccessStatusCode();

        var setRes = await _client.PostAsJsonAsync("/api/webpreview/cookies", new WebPreviewCookieSetRequest
        {
            Raw = "session=abc123; Path=/; HttpOnly"
        }, AppJsonContext.Default.WebPreviewCookieSetRequest);
        setRes.EnsureSuccessStatusCode();

        using var bridgeRequest = new HttpRequestMessage(HttpMethod.Get, "/webpreview/_cookies");
        bridgeRequest.Headers.Referrer = new Uri("https://localhost/webpreview/");
        var bridgeRes = await _client.SendAsync(bridgeRequest);
        bridgeRes.EnsureSuccessStatusCode();
        var bridgeCookies = await bridgeRes.Content.ReadFromJsonAsync(
            AppJsonContext.Default.WebPreviewCookiesResponse);

        Assert.NotNull(bridgeCookies);
        Assert.DoesNotContain("session=abc123", bridgeCookies.Header ?? "", StringComparison.Ordinal);
    }

    private async Task<WebSocket> ConnectWebSocketAsync(string path)
    {
        var wsClient = _factory.Server.CreateWebSocketClient();
        var uri = new Uri(_factory.Server.BaseAddress, path);
        var wsUri = new UriBuilder(uri) { Scheme = uri.Scheme == "https" ? "wss" : "ws" }.Uri;

        var socket = await wsClient.ConnectAsync(wsUri, CancellationToken.None);
        _webSockets.Add(socket);
        return socket;
    }
}
