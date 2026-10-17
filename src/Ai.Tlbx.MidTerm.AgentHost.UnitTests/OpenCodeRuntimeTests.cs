using System.Collections.Concurrent;
using System.IO.Pipelines;
using System.Net;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Xunit;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Ai.Tlbx.MidTerm.Services.Sessions;

namespace Ai.Tlbx.MidTerm.AgentHost.UnitTests;

public sealed class OpenCodeRuntimeTests
{
    [Fact]
    public async Task NativeHttpUsesDirectoryScopeAndConsumesSseBeforeProviderCompletion()
    {
        // This is a local protocol fixture, not an OpenCode process or a paid
        // provider call. Unlike the in-memory cases it exercises real sockets,
        // response-header streaming and disconnect/cancellation semantics.
        using var fake = new OpenCodeTransport();
        using var invoker = new HttpMessageInvoker(fake, disposeHandler: false);
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseKestrel().UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build();
        app.Run(async context =>
        {
            using var request = new HttpRequestMessage(new HttpMethod(context.Request.Method), "http://fixture" + context.Request.Path + context.Request.QueryString);
            if (context.Request.ContentLength is > 0) request.Content = new StreamContent(context.Request.Body);
            using var response = await invoker.SendAsync(request, context.RequestAborted);
            context.Response.StatusCode = (int)response.StatusCode;
            if (context.Request.Path == "/event") context.Response.ContentType = "text/event-stream";
            else context.Response.ContentType = "application/json";
            await context.Response.StartAsync(context.RequestAborted);
            if (context.Request.Path == "/event")
            {
                await context.Response.WriteAsync("data: {\"type\":\"server.connected\",\"properties\":{}}\n\n", context.RequestAborted);
                await context.Response.Body.FlushAsync(context.RequestAborted);
            }
            if (response.StatusCode == HttpStatusCode.NoContent) return;
            await response.Content.CopyToAsync(context.Response.Body, context.RequestAborted);
        });
        await app.StartAsync(CancellationToken.None);
        try
        {
            var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
            var events = new ConcurrentQueue<AppServerControlProviderEvent>();
            using var handler = new HttpClientHandler();
            await using var runtime = new OpenCodeAppServerControlAgentRuntime(events.Enqueue, handler, new Uri(address));
            await runtime.ExecuteAsync(Attach(), CancellationToken.None);
            var result = await runtime.ExecuteAsync(Command("turn.start", turn: new() { Text = "Socket streaming" }), CancellationToken.None);
            await fake.Event("""{"type":"session.status","properties":{"sessionID":"ses_test","status":{"type":"busy"}}}""");
            await fake.Event("""{"type":"message.updated","properties":{"info":{"id":"msg_socket","sessionID":"ses_test","role":"assistant"}}}""");
            await fake.Event("""{"type":"message.part.updated","properties":{"part":{"id":"p-socket","sessionID":"ses_test","messageID":"msg_socket","type":"text","text":"VISIBLE_STREAM_123"}}}""");
            await Until(() => events.Any(e => e.ContentDelta?.Delta == "VISIBLE_STREAM_123"));
            Assert.DoesNotContain(events, e => e.TurnCompleted is not null);
            await fake.Event("""{"type":"session.idle","properties":{"sessionID":"ses_test"}}""");
            await Until(() => events.Any(e => e.TurnCompleted is not null));
            Assert.Equal(result.Result.Accepted!.TurnId, events.Last(e => e.TurnCompleted is not null).TurnId);
            Assert.All(fake.Scopes, directory => Assert.Equal(Path.GetTempPath(), directory));
        }
        finally { await app.StopAsync(CancellationToken.None); }
    }

    [Fact]
    public async Task NativeQuestionsRemainExplicitInAutoModeAndInvalidAnswersAreRetryable()
    {
        using var fake = new OpenCodeTransport();
        var events = new ConcurrentQueue<AppServerControlProviderEvent>();
        var history = new SessionAppServerControlHistoryService();
        await using var runtime = new OpenCodeAppServerControlAgentRuntime(e => { history.Append(e); events.Enqueue(e); }, fake);
        await runtime.ExecuteAsync(Attach(), CancellationToken.None);
        var started = await runtime.ExecuteAsync(Command("turn.start", turn: new() { Text = "Ask me", Model = "test/model", Effort = "high", PermissionMode = "auto" }), CancellationToken.None);
        Assert.NotNull(started.Result.Accepted?.TurnId);
        Assert.Equal(started.Result.Accepted!.TurnId, started.Result.TurnStarted!.TurnId);
        Assert.Equal("ses_test", started.Result.TurnStarted.ThreadId);
        Assert.DoesNotContain(events, e => e.TurnCompleted is not null);
        var prompt = fake.Requests.Last(r => r.Path.EndsWith("/prompt_async", StringComparison.Ordinal));
        using (var body = JsonDocument.Parse(prompt.Body!))
        {
            Assert.Equal("model", body.RootElement.GetProperty("model").GetProperty("modelID").GetString());
            Assert.Equal("high", body.RootElement.GetProperty("variant").GetString());
            Assert.Equal("build", body.RootElement.GetProperty("agent").GetString());
        }
        await fake.Event("""{"type":"question.asked","properties":{"id":"question-native","sessionID":"ses_test","questions":[{"header":"Color","question":"Choose","options":[{"label":"Blue","description":"Ocean"},{"label":"Green","description":"Grass"}],"multiple":true,"custom":true}]}}""");
        await Until(() => events.Any(e => e.UserInputRequested is not null));
        var question = events.Single(e => e.UserInputRequested is not null).UserInputRequested!.Questions.Single();
        Assert.True(question.MultiSelect); Assert.True(question.AllowCustomAnswer);
        var projected = history.GetSnapshot("test-session")!;
        Assert.True(projected.Requests.Single(r => r.RequestId == "question-native").Questions.Single().AllowCustomAnswer);
        Assert.Equal("ses_test", projected.Thread.ThreadId);
        Assert.DoesNotContain(fake.Requests, r => r.Path.EndsWith("/reply", StringComparison.Ordinal));
        var invalid = Command("user-input.resolve");
        invalid.ResolveUserInput = new() { RequestId = "question-native", Answers = [new() { QuestionId = "wrong", Answers = ["Blue"] }] };
        await Assert.ThrowsAsync<InvalidOperationException>(() => runtime.ExecuteAsync(invalid, CancellationToken.None));
        invalid.ResolveUserInput.Answers = [new() { QuestionId = question.Id, Answers = ["Blue", "Violet"] }];
        fake.FailNextReply = true;
        await Assert.ThrowsAsync<InvalidOperationException>(() => runtime.ExecuteAsync(invalid, CancellationToken.None));
        await runtime.ExecuteAsync(invalid, CancellationToken.None);
        Assert.Equal(["Blue", "Violet"], history.GetSnapshot("test-session")!.Requests.Single(r => r.RequestId == "question-native").Answers.Single().Answers);
        var reply = fake.Requests.Last(r => r.Path.EndsWith("/question-native/reply", StringComparison.Ordinal));
        Assert.Equal("{\"answers\":[[\"Blue\",\"Violet\"]]}", reply.Body);
        await Assert.ThrowsAsync<InvalidOperationException>(() => runtime.ExecuteAsync(invalid, CancellationToken.None));
        await fake.Event("""{"type":"session.status","properties":{"sessionID":"ses_test","status":{"type":"busy"}}}""");
        await fake.Event("""{"type":"session.idle","properties":{"sessionID":"ses_test"}}""");
        await Until(() => events.Any(e => e.TurnCompleted?.State == "completed"));
    }

    [Fact]
    public async Task RestoresNativeHistoryAndPendingRequestsWithoutStartingAnotherConversation()
    {
        using var fake = new OpenCodeTransport
        {
            History = """[{"info":{"id":"msg_old","sessionID":"ses_test","role":"user","time":{"created":1792200000000}},"parts":[{"id":"p-user","messageID":"msg_old","sessionID":"ses_test","type":"text","text":"Remember OLD_99"}]},{"info":{"id":"msg_answer","sessionID":"ses_test","role":"assistant","parentID":"msg_old","time":{"created":1792200001000},"modelID":"model","providerID":"test","tokens":{"input":100,"output":20,"reasoning":3,"cache":{"read":40,"write":5}},"cost":0.02},"parts":[{"id":"p-answer","messageID":"msg_answer","sessionID":"ses_test","type":"text","text":"OLD_99"},{"id":"p-tool","messageID":"msg_answer","sessionID":"ses_test","type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"pwd"},"output":"Q:/work","title":"Directory"}}]}]""",
            Questions = """[{"id":"pending-old","sessionID":"ses_test","questions":[{"header":"Next","question":"Continue?","options":[{"label":"Yes","description":"Continue"}],"custom":false}]}]"""
        };
        var events = new ConcurrentQueue<AppServerControlProviderEvent>();
        await using var runtime = new OpenCodeAppServerControlAgentRuntime(events.Enqueue, fake);
        var attach = Attach(resume: true);
        await runtime.ExecuteAsync(attach, CancellationToken.None);
        await runtime.ExecuteAsync(attach, CancellationToken.None);
        Assert.DoesNotContain(fake.Requests, r => r.Method == "POST" && r.Path == "/session");
        Assert.Single(events.Where(e => e.TurnStarted is not null));
        Assert.True(events.Single(e => e.TurnStarted is not null).TurnStarted!.IsReplay);
        Assert.Contains(events, e => e.Item?.ItemType == "user_message" && e.Item.Detail == "Remember OLD_99");
        Assert.Contains(events, e => e.ContentDelta?.Delta == "OLD_99" && e.ItemId == "p-answer");
        Assert.Contains(events, e => e.ItemId == "p-tool" && e.Item?.Status == "completed");
        Assert.Single(events.Where(e => e.UserInputRequested is not null));
        Assert.Equal("waiting", events.Last(e => e.SessionState is not null).SessionState!.State);
        Assert.False(events.Single(e => e.UserInputRequested is not null).UserInputRequested!.Questions[0].AllowCustomAnswer);
        var usage = events.Last(e => e.AgentMetadataUpdated?.Usage is not null).AgentMetadataUpdated!.Usage!;
        Assert.Equal(168, usage.ContextUsedTokens); Assert.Equal(200000, usage.ContextWindowTokens);
        Assert.Equal(0.02m, usage.CostAmount); Assert.Equal(100, usage.InputTokens);
        Assert.Null(events.Single(e => e.TurnStarted is not null).TurnStarted!.Model);
        attach.AttachRuntime!.ResumeThreadId = "ses_other";
        await Assert.ThrowsAsync<InvalidOperationException>(() => runtime.ExecuteAsync(attach, CancellationToken.None));
    }

    [Fact]
    public async Task StreamsSnapshotsAndDeltasWithoutDoubleCountingNativeUsage()
    {
        using var fake = new OpenCodeTransport();
        var events = new ConcurrentQueue<AppServerControlProviderEvent>();
        await using var runtime = new OpenCodeAppServerControlAgentRuntime(events.Enqueue, fake);
        await runtime.ExecuteAsync(Attach(), CancellationToken.None);
        await runtime.ExecuteAsync(Command("turn.start", turn: new() { Text = "Hello" }), CancellationToken.None);
        await fake.Event("""{"type":"message.updated","properties":{"info":{"id":"msg_a","sessionID":"ses_test","role":"assistant","providerID":"test","modelID":"model","time":{"created":1},"tokens":{"input":10,"output":1,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0.01}}}""");
        await fake.Event("""{"type":"message.part.updated","properties":{"part":{"id":"p1","messageID":"msg_a","sessionID":"ses_test","type":"text","text":"Hello"}}}""");
        await fake.Event("""{"type":"message.part.delta","properties":{"sessionID":"ses_test","messageID":"msg_a","partID":"p1","field":"text","delta":" world"}}""");
        await fake.Event("""{"type":"message.part.updated","properties":{"part":{"id":"p1","messageID":"msg_a","sessionID":"ses_test","type":"text","text":"Hello world"}}}""");
        await fake.Event("""{"type":"message.updated","properties":{"info":{"id":"msg_a","sessionID":"ses_test","role":"assistant","providerID":"test","modelID":"model","time":{"created":1},"tokens":{"input":10,"output":5,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0.02}}}""");
        await Until(() => events.LastOrDefault(e => e.AgentMetadataUpdated?.Usage is not null)?.AgentMetadataUpdated?.Usage?.OutputTokens == 5);
        Assert.All(events.Where(e => e.ContentDelta is not null), e => Assert.True(e.ContentDelta!.Replace));
        Assert.Equal("Hello world", events.Last(e => e.ContentDelta is not null).ContentDelta!.Delta);
        Assert.Equal(0.02m, events.Last(e => e.AgentMetadataUpdated?.Usage is not null).AgentMetadataUpdated!.Usage!.CostAmount);
        Assert.DoesNotContain(events, e => e.TurnCompleted is not null);
    }

    [Fact]
    public async Task SteeringWaitsForNativeIdleAndRejectsStaleTargets()
    {
        using var fake = new OpenCodeTransport();
        var events = new ConcurrentQueue<AppServerControlProviderEvent>();
        await using var runtime = new OpenCodeAppServerControlAgentRuntime(events.Enqueue, fake);
        await runtime.ExecuteAsync(Attach(), CancellationToken.None);
        var first = await runtime.ExecuteAsync(Command("turn.start", turn: new() { Text = "Count" }), CancellationToken.None);
        var steer = Command("turn.steer"); steer.SteerTurn = new() { Text = "Stop at ten", ExpectedTurnId = "stale" };
        await Assert.ThrowsAsync<InvalidOperationException>(() => runtime.ExecuteAsync(steer, CancellationToken.None));
        Assert.DoesNotContain(fake.Requests, r => r.Path.EndsWith("/abort", StringComparison.Ordinal));
        steer.SteerTurn.ExpectedTurnId = first.Result.Accepted!.TurnId;
        var pending = runtime.ExecuteAsync(steer, CancellationToken.None);
        await Until(() => fake.Requests.Any(r => r.Path.EndsWith("/abort", StringComparison.Ordinal)));
        Assert.False(pending.IsCompleted);
        Assert.Single(fake.Requests.Where(r => r.Path.EndsWith("/prompt_async", StringComparison.Ordinal)));
        await fake.Event("""{"type":"session.idle","properties":{"sessionID":"ses_test"}}""");
        var second = await pending.WaitAsync(TimeSpan.FromSeconds(5), CancellationToken.None);
        Assert.False(string.Equals(first.Result.Accepted.TurnId, second.Result.Accepted!.TurnId, StringComparison.Ordinal));
        Assert.Equal(2, fake.Requests.Count(r => r.Path.EndsWith("/prompt_async", StringComparison.Ordinal)));
        Assert.Contains(events, e => e.TurnId == first.Result.Accepted.TurnId && e.TurnCompleted?.State == "interrupted");
    }

    [Theory]
    [InlineData("1.1.26")]
    [InlineData("bad")]
    public async Task RejectsUnsupportedNativeServerBeforeOpeningSession(string version)
    {
        using var fake = new OpenCodeTransport { Version = version };
        await using var runtime = new OpenCodeAppServerControlAgentRuntime(_ => { }, fake);
        await Assert.ThrowsAsync<InvalidOperationException>(() => runtime.ExecuteAsync(Attach(), CancellationToken.None));
        Assert.DoesNotContain(fake.Requests, r => r.Path == "/session");
    }

    [Fact]
    public async Task CompactionReportsNativeFailureAndUsesSelectedProviderModel()
    {
        using var fake = new OpenCodeTransport { Summarize = "false" };
        var events = new ConcurrentQueue<AppServerControlProviderEvent>();
        await using var runtime = new OpenCodeAppServerControlAgentRuntime(events.Enqueue, fake);
        await runtime.ExecuteAsync(Attach(), CancellationToken.None);
        await runtime.ExecuteAsync(Command("thread.compact"), CancellationToken.None);
        await Until(() => events.Any(e => e.TurnCompleted is not null));
        Assert.Equal("failed", events.Last(e => e.TurnCompleted is not null).TurnCompleted!.State);
        Assert.Contains("declined", events.Last(e => e.TurnCompleted is not null).TurnCompleted!.ErrorMessage, StringComparison.Ordinal);
        using var body = JsonDocument.Parse(fake.Requests.Single(r => r.Path.EndsWith("/summarize", StringComparison.Ordinal)).Body!);
        Assert.Equal("test", body.RootElement.GetProperty("providerID").GetString());
        Assert.Equal("model", body.RootElement.GetProperty("modelID").GetString());
    }

    [Fact]
    public async Task ReconnectReconcilesSnapshotsAndNativeIdleWithoutDuplicatingBufferedDeltas()
    {
        using var fake = new OpenCodeTransport();
        var events = new ConcurrentQueue<AppServerControlProviderEvent>();
        await using var runtime = new OpenCodeAppServerControlAgentRuntime(events.Enqueue, fake);
        await runtime.ExecuteAsync(Attach(), CancellationToken.None);
        await runtime.ExecuteAsync(Command("turn.start", turn: new() { Text = "Continue after reconnect" }), CancellationToken.None);
        await fake.Event("""{"type":"session.status","properties":{"sessionID":"ses_test","status":{"type":"busy"}}}""");
        await fake.Event("""{"type":"message.updated","properties":{"info":{"id":"msg_a","sessionID":"ses_test","role":"assistant","providerID":"test","modelID":"model"}}}""");
        await fake.Event("""{"type":"message.part.updated","properties":{"part":{"id":"p1","messageID":"msg_a","sessionID":"ses_test","type":"text","text":"A"}}}""");
        await Until(() => events.Any(e => e.ContentDelta?.Delta == "A"));
        fake.History = """[{"info":{"id":"msg_a","sessionID":"ses_test","role":"assistant","providerID":"test","modelID":"model"},"parts":[{"id":"p1","messageID":"msg_a","sessionID":"ses_test","type":"text","text":"AB"}]}]""";
        await fake.Disconnect();
        await Until(() => fake.EventConnections == 2 && events.Any(e => e.ContentDelta?.Delta == "AB"));
        await fake.Event("""{"type":"message.part.delta","properties":{"sessionID":"ses_test","messageID":"msg_a","partID":"p1","field":"text","delta":"B"}}""");
        await fake.Event("""{"type":"session.idle","properties":{"sessionID":"ses_test"}}""");
        await Until(() => events.Any(e => e.TurnCompleted is not null));
        Assert.DoesNotContain(events, e => e.ContentDelta?.Delta == "ABB");
        Assert.Equal("AB", events.Last(e => e.ContentDelta is not null).ContentDelta!.Delta);
        Assert.Single(fake.Requests.Where(r => r.Method == "POST" && r.Path == "/session"));
        Assert.Single(events.Where(e => e.TurnCompleted is not null));
    }

    [Fact]
    public async Task NativeUndoMarkerExcludesRevertedMessagesFromColdResume()
    {
        using var fake = new OpenCodeTransport
        {
            Session = """{"id":"ses_test","revert":{"messageID":"msg_reverted"}}""",
            History = """[{"info":{"id":"msg_keep","sessionID":"ses_test","role":"user"},"parts":[{"id":"p-keep","messageID":"msg_keep","type":"text","text":"Keep"}]},{"info":{"id":"msg_reverted","sessionID":"ses_test","role":"user"},"parts":[{"id":"p-reverted","messageID":"msg_reverted","type":"text","text":"Reverted"}]}]"""
        };
        var events = new ConcurrentQueue<AppServerControlProviderEvent>();
        await using var runtime = new OpenCodeAppServerControlAgentRuntime(events.Enqueue, fake);
        await runtime.ExecuteAsync(Attach(resume: true), CancellationToken.None);
        Assert.Contains(events, e => e.Item?.Detail == "Keep");
        Assert.DoesNotContain(events, e => e.Item?.Detail == "Reverted");
    }

    [Fact]
    public async Task NativeChoicesRejectCustomAnswersWhenDisabledAndPermissionReplyIsRetryable()
    {
        using var fake = new OpenCodeTransport();
        var events = new ConcurrentQueue<AppServerControlProviderEvent>();
        await using var runtime = new OpenCodeAppServerControlAgentRuntime(events.Enqueue, fake);
        await runtime.ExecuteAsync(Attach(), CancellationToken.None);
        await runtime.ExecuteAsync(Command("turn.start", turn: new() { Text = "Ask" }), CancellationToken.None);
        await fake.Event("""{"type":"question.asked","properties":{"id":"strict","sessionID":"ses_test","questions":[{"header":"Color","question":"Choose","options":[{"label":"Blue","description":"Ocean"}],"custom":false}]}}""");
        await fake.Event("""{"type":"permission.asked","properties":{"id":"perm","sessionID":"ses_test","permission":"bash","patterns":["git status"]}}""");
        await Until(() => events.Any(e => e.RequestId == "perm"));
        var answer = Command("user-input.resolve"); answer.ResolveUserInput = new() { RequestId = "strict", Answers = [new() { QuestionId = "question-0", Answers = ["Violet"] }] };
        await Assert.ThrowsAsync<InvalidOperationException>(() => runtime.ExecuteAsync(answer, CancellationToken.None));
        Assert.DoesNotContain(fake.Requests, r => r.Path == "/question/strict/reply");
        var approve = Command("request.resolve"); approve.ResolveRequest = new() { RequestId = "perm", Decision = "accept" };
        fake.FailNextReply = true;
        await Assert.ThrowsAsync<InvalidOperationException>(() => runtime.ExecuteAsync(approve, CancellationToken.None));
        await runtime.ExecuteAsync(approve, CancellationToken.None);
        Assert.Equal("{\"reply\":\"once\"}", fake.Requests.Last(r => r.Path == "/permission/perm/reply").Body);
        await Assert.ThrowsAsync<InvalidOperationException>(() => runtime.ExecuteAsync(approve, CancellationToken.None));
    }

    [Fact]
    public async Task RejectsInventedModelsAndVariantsBeforeSubmittingAnyPrompt()
    {
        using var fake = new OpenCodeTransport();
        await using var runtime = new OpenCodeAppServerControlAgentRuntime(_ => { }, fake);
        await runtime.ExecuteAsync(Attach(), CancellationToken.None);
        await Assert.ThrowsAsync<InvalidOperationException>(() => runtime.ExecuteAsync(Command("turn.start", turn: new() { Text = "Test", Model = "invented/model" }), CancellationToken.None));
        await Assert.ThrowsAsync<InvalidOperationException>(() => runtime.ExecuteAsync(Command("turn.start", turn: new() { Text = "Test", Effort = "disabled" }), CancellationToken.None));
        Assert.DoesNotContain(fake.Requests, r => r.Path.EndsWith("/prompt_async", StringComparison.Ordinal));
    }

    [Fact]
    public async Task DoesNotChooseAnUnconfiguredPaidModelFromCatalogueOrder()
    {
        using var fake = new OpenCodeTransport
        {
            Config = "{}",
            ProviderOverride = """{"connected":["test"],"all":[{"id":"test","models":{"expensive":{"id":"expensive"},"cheap":{"id":"cheap"}}}]}"""
        };
        var events = new ConcurrentQueue<AppServerControlProviderEvent>();
        await using var runtime = new OpenCodeAppServerControlAgentRuntime(events.Enqueue, fake);
        await runtime.ExecuteAsync(Attach(), CancellationToken.None);
        Assert.Null(events.Last(e => e.QuickSettingsUpdated is not null).QuickSettingsUpdated!.Model);
        await Assert.ThrowsAsync<InvalidOperationException>(() => runtime.ExecuteAsync(Command("turn.start", turn: new() { Text = "Test" }), CancellationToken.None));
        Assert.DoesNotContain(fake.Requests, r => r.Path.EndsWith("/prompt_async", StringComparison.Ordinal));
        var selected = await runtime.ExecuteAsync(Command("turn.start", turn: new() { Text = "Test", Model = "test/cheap" }), CancellationToken.None);
        Assert.Equal("test/cheap", selected.Result.TurnStarted!.QuickSettings.Model);
    }

    [Theory]
    [InlineData("/review local changes", "/command")]
    [InlineData("/unknown local changes", "/prompt_async")]
    [InlineData("/compact", "/summarize")]
    public async Task RoutesNativeCommandsAndCompactionWithoutSyntheticPlanningText(string text, string endpoint)
    {
        using var fake = new OpenCodeTransport();
        var events = new ConcurrentQueue<AppServerControlProviderEvent>();
        await using var runtime = new OpenCodeAppServerControlAgentRuntime(events.Enqueue, fake);
        await runtime.ExecuteAsync(Attach(), CancellationToken.None);
        var result = await runtime.ExecuteAsync(Command("turn.start", turn: new() { Text = text, PlanMode = "on", Effort = "low" }), CancellationToken.None);
        Assert.Equal("on", result.Result.TurnStarted!.QuickSettings.PlanMode);
        await Until(() => fake.Requests.Any(r => r.Path.EndsWith(endpoint, StringComparison.Ordinal)));
        var sent = fake.Requests.Last(r => r.Path.EndsWith(endpoint, StringComparison.Ordinal));
        using var body = JsonDocument.Parse(sent.Body!);
        if (endpoint == "/command")
        {
            Assert.Equal("review", body.RootElement.GetProperty("command").GetString());
            Assert.Equal("local changes", body.RootElement.GetProperty("arguments").GetString());
            Assert.Equal("test/model", body.RootElement.GetProperty("model").GetString());
        }
        else if (endpoint == "/prompt_async") Assert.Equal(text, body.RootElement.GetProperty("parts")[0].GetProperty("text").GetString());
        if (endpoint != "/summarize") Assert.Equal("plan", body.RootElement.GetProperty("agent").GetString());
        Assert.Contains(events, e => e.Item?.ItemType == "user_message" && e.Item.Detail == text);
    }

    [Fact]
    public void ServerLaunchKeepsNativeArgumentsAndHandlesWindowsNpmShims()
    {
        var directory = Path.GetTempPath();
        var native = OpenCodeAppServerControlAgentRuntime.CreateServerStartInfo("opencode.exe", ["--log-level", "WARN"], directory, 22345);
        Assert.Equal(["--log-level", "WARN", "serve", "--hostname", "127.0.0.1", "--port", "22345"], native.ArgumentList);
        Assert.True(native.CreateNoWindow); Assert.True(native.RedirectStandardError); Assert.True(native.RedirectStandardOutput);
        if (!OperatingSystem.IsWindows()) return;
        var shim = OpenCodeAppServerControlAgentRuntime.CreateServerStartInfo("C:\\Program Files\\npm\\opencode.cmd", [], directory, 22345);
        Assert.Contains("/d /s /c", shim.Arguments, StringComparison.Ordinal);
        Assert.Contains("\"C:\\Program Files\\npm\\opencode.cmd\"", shim.Arguments, StringComparison.Ordinal);
        Assert.Throws<InvalidOperationException>(() => OpenCodeAppServerControlAgentRuntime.CreateServerStartInfo("opencode.cmd", ["unsafe&argument"], directory, 22345));
    }

    [Fact]
    public async Task DelegatedQuestionIsVisibleAndChildIdleDoesNotFinishTheParentTurn()
    {
        using var fake = new OpenCodeTransport();
        var events = new ConcurrentQueue<AppServerControlProviderEvent>();
        await using var runtime = new OpenCodeAppServerControlAgentRuntime(events.Enqueue, fake);
        await runtime.ExecuteAsync(Attach(), CancellationToken.None);
        var started = await runtime.ExecuteAsync(Command("turn.start", turn: new() { Text = "Delegate a task" }), CancellationToken.None);
        await fake.Event("""{"type":"session.status","properties":{"sessionID":"ses_test","status":{"type":"busy"}}}""");
        await fake.Event("""{"type":"session.created","properties":{"info":{"id":"ses_child","parentID":"ses_test"}}}""");
        await fake.Event("""{"type":"session.created","properties":{"info":{"id":"ses_grandchild","parentID":"ses_child"}}}""");
        await fake.Event("""{"type":"question.asked","properties":{"id":"child-question","sessionID":"ses_grandchild","questions":[{"header":"Color","question":"Choose","options":[{"label":"Blue","description":"Ocean"}],"custom":false}]}}""");
        await fake.Event("""{"type":"session.idle","properties":{"sessionID":"ses_child"}}""");
        await Until(() => events.Any(e => e.Task?.TaskId == "ses_child"));
        Assert.DoesNotContain(events, e => e.TurnCompleted is not null);
        Assert.Contains(events, e => e.RequestId == "child-question" && e.TurnId == started.Result.TurnStarted!.TurnId && e.UserInputRequested is not null);
        var answer = Command("user-input.resolve"); answer.ResolveUserInput = new() { RequestId = "child-question", Answers = [new() { QuestionId = "question-0", Answers = ["Blue"] }] };
        await runtime.ExecuteAsync(answer, CancellationToken.None);
        Assert.Contains(fake.Requests, r => r.Path == "/question/child-question/reply");
        await fake.Event("""{"type":"session.idle","properties":{"sessionID":"ses_test"}}""");
        await Until(() => events.Any(e => e.TurnCompleted is not null));
        Assert.Single(events.Where(e => e.TurnCompleted is not null));
    }

    private static AppServerControlHostCommandEnvelope Attach(bool resume = false) => new()
    {
        Type = "runtime.attach", CommandId = Guid.NewGuid().ToString("N"), SessionId = "test-session",
        AttachRuntime = new() { Provider = "opencode", WorkingDirectory = Path.GetTempPath(), ResumeThreadId = resume ? "ses_test" : null }
    };
    private static AppServerControlHostCommandEnvelope Command(string type, AppServerControlTurnRequest? turn = null) => new() { Type = type, CommandId = Guid.NewGuid().ToString("N"), SessionId = "test-session", StartTurn = turn };
    private static async Task Until(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!condition()) await Task.Delay(10, timeout.Token);
    }

    private sealed class OpenCodeTransport : HttpMessageHandler
    {
        private Pipe _events = new();
        private readonly List<Pipe> _pipes = [];
        private bool _disposed;
        public ConcurrentQueue<(string Method, string Path, string? Body)> Requests { get; } = new();
        public ConcurrentQueue<string> Scopes { get; } = new();
        public string Version { get; init; } = "1.19.3";
        public string Config { get; init; } = """{"model":"test/model","default_agent":"build"}""";
        public string? ProviderOverride { get; init; }
        public string History { get; set; } = "[]";
        public string Session { get; init; } = """{"id":"ses_test"}""";
        public string Questions { get; init; } = "[]";
        public string Summarize { get; init; } = "true";
        public string Statuses { get; private set; } = "{}";
        public bool FailNextReply { get; set; }
        public int EventConnections { get; private set; }

        public async Task Event(string json)
        {
            using var parsed = JsonDocument.Parse(json);
            var root = parsed.RootElement;
            var type = root.GetProperty("type").GetString();
            var properties = root.GetProperty("properties");
            if (properties.TryGetProperty("sessionID", out var session) && session.GetString() == "ses_test")
            {
                if (type == "session.idle") Statuses = "{}";
                else if (type == "session.status")
                {
                    var status = properties.GetProperty("status");
                    Statuses = status.GetProperty("type").GetString() == "idle" ? "{}" : "{\"ses_test\":" + status.GetRawText() + "}";
                }
            }
            await _events.Writer.WriteAsync(Encoding.UTF8.GetBytes("data: " + json + "\n\n"), CancellationToken.None);
        }
        public async Task Disconnect() => await _events.Writer.CompleteAsync();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            var scope = System.Web.HttpUtility.ParseQueryString(request.RequestUri.Query)["directory"];
            if (scope is not null) Scopes.Enqueue(scope);
            var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Enqueue((request.Method.Method, path, body));
            if (request.Method == HttpMethod.Post && (path.EndsWith("/prompt_async", StringComparison.Ordinal) || path.EndsWith("/command", StringComparison.Ordinal)))
            {
                using var prompt = JsonDocument.Parse(body!);
                var nativeId = prompt.RootElement.GetProperty("messageID").GetString();
                await Event("{\"type\":\"message.updated\",\"properties\":{\"info\":{\"id\":\"" + nativeId + "\",\"sessionID\":\"ses_test\",\"role\":\"user\"}}}");
            }
            // StreamContent owns and disposes this adapter stream.
#pragma warning disable IDISP004
            if (path == "/event")
            {
                if (EventConnections > 0) _events = new Pipe();
                _pipes.Add(_events); EventConnections++;
                return new(HttpStatusCode.OK) { Content = new StreamContent(_events.Reader.AsStream(leaveOpen: true)) };
            }
#pragma warning restore IDISP004
            if (path.EndsWith("/reply", StringComparison.Ordinal) && FailNextReply)
            {
                FailNextReply = false; return new(HttpStatusCode.ServiceUnavailable);
            }
            var json = path switch
            {
                "/global/health" => "{\"healthy\":true,\"version\":\"" + Version + "\"}",
                "/provider" => ProviderOverride ?? """{"connected":["test"],"all":[{"id":"test","name":"Test provider","models":{"model":{"id":"model","name":"Native model","status":"active","capabilities":{"input":{"image":true}},"limit":{"context":200000},"variants":{"low":{},"high":{},"disabled":{"disabled":true}}}}}]}""",
                "/agent" => """[{"name":"build","mode":"primary"},{"name":"plan","mode":"primary"},{"name":"explore","mode":"subagent"}]""",
                "/command" => """[{"name":"review","description":"Review changes"}]""",
                "/config" => Config,
                "/session" or "/session/ses_test" => Session,
                "/session/status" => Statuses,
                _ when path.EndsWith("/children", StringComparison.Ordinal) => "[]",
                "/session/ses_test/message" => History,
                "/permission" => "[]",
                "/question" => Questions,
                "/session/ses_test/summarize" => Summarize,
                _ => "true"
            };
            return new(path.EndsWith("/prompt_async", StringComparison.Ordinal) ? HttpStatusCode.NoContent : HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing && !_disposed)
            {
                _disposed = true;
                foreach (var pipe in _pipes) { pipe.Writer.Complete(); pipe.Reader.Complete(); }
            }
            base.Dispose(disposing);
        }
    }
}
