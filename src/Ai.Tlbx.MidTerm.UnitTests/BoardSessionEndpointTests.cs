using System.Net.Http.Json;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Services.Boards;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class BoardSessionEndpointTests
{
    private static readonly HttpClient Client = new();
    [Theory]
    [InlineData("ok", "submitted")]
    [InlineData("bootstrap-failed", "failed")]
    [InlineData("prompt-unknown", "uncertain")]
    public async Task InitialPromptUsesAppendAndRetryDoesNotStartOrSubmitTwice(string outcome, string expectedState)
    {
        var directory = Path.Combine(Path.GetTempPath(), $"tlbx-board-launch-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            using var boards = new BoardService(directory);
            var board = boards.Create(new() { WorkingDirectory = directory, LaunchCommand = "custom-agent", SessionProfile = "generic-ai" });
            var item = boards.WriteItem(board.Id, null, new() { Item = new() { Text = "Exact task" } })!;
            var builder = WebApplication.CreateSlimBuilder();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            builder.Services.AddSingleton(boards);
            builder.Services.ConfigureHttpJsonOptions(options => options.SerializerOptions.TypeInfoResolverChain.Insert(0, BoardJsonContext.Default));
            await using var app = builder.Build();
            var starts = 0;
            var prompts = 0;
            BoardSessionEndpoints.Map(app, (request, _, created) =>
            {
                starts++;
                Assert.Equal("custom-agent", request.LaunchCommand);
                if (outcome == "bootstrap-failed") return Task.FromResult<IResult>(Results.BadRequest("Cannot start"));
                created?.Invoke("task-session");
                return Task.FromResult<IResult>(Results.Json(new WorkerBootstrapResponse
                {
                    Session = new() { Id = "task-session" }, Profile = "generic-ai"
                }, AppJsonContext.Default.WorkerBootstrapResponse));
            }, (id, request, _, _, recordBrowserInput) =>
            {
                prompts++;
                Assert.Equal("task-session", id);
                Assert.Equal("append", request.Mode);
                Assert.False(recordBrowserInput);
                Assert.Contains("Exact task", request.Text, StringComparison.Ordinal);
                if (outcome == "prompt-unknown") throw new IOException("Delivery disconnected");
                return Task.FromResult<IResult>(Results.Ok());
            });
            await app.StartAsync(TestContext.Current.CancellationToken);
            var origin = app.Urls.Single();
            var request = new BoardLaunchRequest { RequestId = Guid.NewGuid().ToString("N"), ExpectedRevision = item.Revision };
            for (var attempt = 0; attempt < 2; attempt++)
            {
                using var response = await Client.PostAsJsonAsync($"{origin}/api/boards/{board.Id}/items/{item.Id}/launch", request, BoardJsonContext.Default.BoardLaunchRequest, TestContext.Current.CancellationToken);
                response.EnsureSuccessStatusCode();
                var result = await response.Content.ReadFromJsonAsync(BoardJsonContext.Default.BoardLaunch, TestContext.Current.CancellationToken);
                Assert.Equal(expectedState, result!.State);
                Assert.Equal(outcome == "bootstrap-failed" ? null : "task-session", result.SessionId);
            }
            Assert.Equal(1, starts);
            Assert.Equal(outcome == "bootstrap-failed" ? 0 : 1, prompts);
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            Directory.Delete(directory, true);
        }
    }
}
