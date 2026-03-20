using System.Text.Json;
using System.Threading.Channels;
using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.AgentHost;

internal sealed class LensAgentHostServer : IAsyncDisposable
{
    private readonly string? _syntheticProvider;
    private readonly Channel<string> _outbound = Channel.CreateUnbounded<string>(new UnboundedChannelOptions
    {
        SingleReader = true,
        SingleWriter = false
    });
    private readonly CancellationTokenSource _shutdown = new();
    private Task? _writerTask;
    private ILensAgentRuntime? _runtime;

    public LensAgentHostServer(string? syntheticProvider)
    {
        _syntheticProvider = string.IsNullOrWhiteSpace(syntheticProvider)
            ? null
            : syntheticProvider.Trim().ToLowerInvariant();
    }

    public async Task RunAsync()
    {
        using var reader = new StreamReader(Console.OpenStandardInput());
        using var writer = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };

        _writerTask = Task.Run(() => WriteLoopAsync(writer, _shutdown.Token), CancellationToken.None);
        await EnqueueHelloAsync().ConfigureAwait(false);

        while (await reader.ReadLineAsync().ConfigureAwait(false) is { } line)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            LensHostCommandEnvelope? command;
            try
            {
                command = JsonSerializer.Deserialize(line, LensHostJsonContext.Default.LensHostCommandEnvelope);
            }
            catch (JsonException ex)
            {
                await EnqueueAsync(new LensHostCommandResultEnvelope
                {
                    CommandId = "invalid-json",
                    SessionId = string.Empty,
                    Status = "rejected",
                    Message = ex.Message
                }).ConfigureAwait(false);
                continue;
            }

            if (command is null)
            {
                continue;
            }

            HostCommandOutcome outcome;
            try
            {
                var runtime = await GetRuntimeAsync(command).ConfigureAwait(false);
                outcome = await runtime.ExecuteAsync(command, _shutdown.Token).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                outcome = new HostCommandOutcome
                {
                    Result = new LensHostCommandResultEnvelope
                    {
                        CommandId = command.CommandId,
                        SessionId = command.SessionId,
                        Status = "rejected",
                        Message = ex.Message
                    }
                };
            }

            await EnqueueAsync(outcome.Result).ConfigureAwait(false);
            foreach (var envelope in outcome.Events)
            {
                await EnqueueAsync(envelope).ConfigureAwait(false);
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        _shutdown.Cancel();
        _outbound.Writer.TryComplete();
        if (_runtime is not null)
        {
            await _runtime.DisposeAsync().ConfigureAwait(false);
        }

        if (_writerTask is not null)
        {
            await Task.WhenAny(_writerTask, Task.Delay(250)).ConfigureAwait(false);
        }

        _shutdown.Dispose();
    }

    private async Task EnqueueHelloAsync()
    {
        await EnqueueAsync(new LensHostHello
        {
            HostKind = "mtagenthost",
            HostVersion = "dev",
            Providers = _syntheticProvider is null ? ["codex"] : [_syntheticProvider],
            Capabilities =
            [
                "attach",
                "turn.start",
                "turn.interrupt",
                "request.resolve",
                "user-input.resolve"
            ]
        }).ConfigureAwait(false);
    }

    private async Task<ILensAgentRuntime> GetRuntimeAsync(LensHostCommandEnvelope command)
    {
        ValidateCommand(command);
        if (_runtime is not null)
        {
            return _runtime;
        }

        if (!string.Equals(command.Type, "runtime.attach", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("runtime.attach must be the first command sent to mtagenthost.");
        }

        var provider = _syntheticProvider ?? command.AttachRuntime?.Provider?.Trim().ToLowerInvariant();
        _runtime = provider switch
        {
            "codex" when _syntheticProvider is null => new CodexLensAgentRuntime(EmitAsyncEvent),
            "codex" => new SyntheticLensAgentRuntime(provider, EmitAsyncEvent),
            "claude" when _syntheticProvider is not null => new SyntheticLensAgentRuntime(provider, EmitAsyncEvent),
            _ => throw new InvalidOperationException($"mtagenthost does not support provider '{provider ?? "(null)"}'.")
        };

        return _runtime;
    }

    private static void ValidateCommand(LensHostCommandEnvelope command)
    {
        if (!string.Equals(command.ProtocolVersion, LensHostProtocol.CurrentVersion, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Unsupported protocol version '{command.ProtocolVersion}'.");
        }

        if (string.IsNullOrWhiteSpace(command.CommandId))
        {
            throw new InvalidOperationException("Command id is required.");
        }

        if (string.IsNullOrWhiteSpace(command.SessionId))
        {
            throw new InvalidOperationException("Session id is required.");
        }
    }

    private void EmitAsyncEvent(LensHostEventEnvelope envelope)
    {
        _outbound.Writer.TryWrite(JsonSerializer.Serialize(envelope, LensHostJsonContext.Default.LensHostEventEnvelope));
    }

    private async Task EnqueueAsync(LensHostHello hello)
    {
        await _outbound.Writer.WriteAsync(
            JsonSerializer.Serialize(hello, LensHostJsonContext.Default.LensHostHello),
            _shutdown.Token).ConfigureAwait(false);
    }

    private async Task EnqueueAsync(LensHostCommandResultEnvelope result)
    {
        await _outbound.Writer.WriteAsync(
            JsonSerializer.Serialize(result, LensHostJsonContext.Default.LensHostCommandResultEnvelope),
            _shutdown.Token).ConfigureAwait(false);
    }

    private async Task EnqueueAsync(LensHostEventEnvelope envelope)
    {
        await _outbound.Writer.WriteAsync(
            JsonSerializer.Serialize(envelope, LensHostJsonContext.Default.LensHostEventEnvelope),
            _shutdown.Token).ConfigureAwait(false);
    }

    private async Task WriteLoopAsync(StreamWriter writer, CancellationToken ct)
    {
        try
        {
            while (await _outbound.Reader.WaitToReadAsync(ct).ConfigureAwait(false))
            {
                while (_outbound.Reader.TryRead(out var line))
                {
                    await writer.WriteLineAsync(line).ConfigureAwait(false);
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
    }
}
