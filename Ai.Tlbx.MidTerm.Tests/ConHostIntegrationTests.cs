using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Services;
using Xunit;
using Xunit.Abstractions;

namespace Ai.Tlbx.MidTerm.Tests;

/// <summary>
/// Integration tests for mmttyhost.exe process directly.
/// These tests spawn mmttyhost, connect via named pipe, and verify the IPC protocol works.
/// </summary>
public class ConHostIntegrationTests : IAsyncLifetime
{
    private readonly ITestOutputHelper _output;
    private Process? _conHostProcess;
    private string? _sessionId;
    private NamedPipeClientStream? _pipe;

    private static readonly string ConHostPath = FindConHostExe();

    public ConHostIntegrationTests(ITestOutputHelper output)
    {
        _output = output;
    }

    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync()
    {
        if (_pipe is not null)
        {
            try { _pipe.Dispose(); } catch { }
        }

        if (_conHostProcess is not null && !_conHostProcess.HasExited)
        {
            try
            {
                _conHostProcess.Kill();
                await _conHostProcess.WaitForExitAsync();
            }
            catch { }
            _conHostProcess.Dispose();
        }
    }

    [Fact]
    public void ConHostExe_Exists()
    {
        _output.WriteLine($"Looking for mmttyhost.exe at: {ConHostPath}");
        Assert.True(File.Exists(ConHostPath), $"mmttyhost.exe not found at {ConHostPath}");
    }

    [Fact]
    public async Task ConHost_Spawn_CreatesNamedPipe()
    {
        _sessionId = GenerateSessionId();
        var pipeName = $"mm-con-{_sessionId}";

        _output.WriteLine($"Spawning mmttyhost with session {_sessionId}");
        _conHostProcess = StartConHost(_sessionId);

        // Wait for pipe to be created
        var pipeExists = await WaitForPipeAsync(pipeName, TimeSpan.FromSeconds(5));

        _output.WriteLine($"Pipe exists: {pipeExists}");
        Assert.True(pipeExists, $"Named pipe {pipeName} was not created");
    }

    [Fact]
    public async Task ConHost_Connect_GetInfo_ReturnsSessionInfo()
    {
        _sessionId = GenerateSessionId();
        var pipeName = $"mm-con-{_sessionId}";

        _output.WriteLine($"Starting mmttyhost with session {_sessionId}");
        _conHostProcess = StartConHost(_sessionId);

        Assert.True(await WaitForPipeAsync(pipeName, TimeSpan.FromSeconds(5)), "Pipe not created");

        // Connect to pipe
        _pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await _pipe.ConnectAsync(5000);
        _output.WriteLine("Connected to pipe");

        // Send GetInfo request
        var request = ConHostProtocol.CreateInfoRequest();
        await _pipe.WriteAsync(request);
        _output.WriteLine($"Sent GetInfo request ({request.Length} bytes)");

        // Read response
        var response = await ReadMessageAsync(_pipe, TimeSpan.FromSeconds(5));
        Assert.NotNull(response);

        var (msgType, payload) = response.Value;
        _output.WriteLine($"Received response: type={msgType}, payload={payload.Length} bytes");

        Assert.Equal(ConHostMessageType.Info, msgType);

        var info = ConHostProtocol.ParseInfo(payload.Span);
        Assert.NotNull(info);
        _output.WriteLine($"SessionInfo: Id={info.Id}, Pid={info.Pid}, Shell={info.ShellType}, Running={info.IsRunning}");

        Assert.Equal(_sessionId, info.Id);
        Assert.True(info.Pid > 0);
        Assert.True(info.IsRunning);
    }

    [Fact]
    public async Task ConHost_ReceivesOutput_FromShell()
    {
        _sessionId = GenerateSessionId();
        var pipeName = $"mm-con-{_sessionId}";

        _output.WriteLine($"Starting mmttyhost with session {_sessionId}");
        _conHostProcess = StartConHost(_sessionId);

        Assert.True(await WaitForPipeAsync(pipeName, TimeSpan.FromSeconds(5)), "Pipe not created");

        _pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await _pipe.ConnectAsync(5000);
        _output.WriteLine("Connected to pipe");

        // First do GetInfo handshake
        var request = ConHostProtocol.CreateInfoRequest();
        await _pipe.WriteAsync(request);
        var infoResponse = await ReadMessageAsync(_pipe, TimeSpan.FromSeconds(5));
        Assert.NotNull(infoResponse);
        Assert.Equal(ConHostMessageType.Info, infoResponse.Value.type);
        _output.WriteLine("GetInfo handshake complete");

        // Send Enter to force a prompt (pwsh takes several seconds to start)
        var enterMsg = ConHostProtocol.CreateInputMessage(Encoding.UTF8.GetBytes("\r\n"));
        await _pipe.WriteAsync(enterMsg);
        _output.WriteLine("Sent Enter to force prompt");

        // Wait for Output messages
        var outputReceived = new List<byte>();
        var deadline = DateTime.UtcNow.AddSeconds(10); // Longer timeout for slow shells

        while (DateTime.UtcNow < deadline)
        {
            var msg = await ReadMessageAsync(_pipe, TimeSpan.FromMilliseconds(500));
            if (msg is null) continue;

            var (type, payload) = msg.Value;
            _output.WriteLine($"Received message: type={type}, payload={payload.Length} bytes");

            if (type == ConHostMessageType.Output)
            {
                outputReceived.AddRange(payload.ToArray());
                var text = Encoding.UTF8.GetString(payload.Span);
                _output.WriteLine($"Output: [{text.Length} chars] {Escape(text)}");

                // Wait for substantial output (prompt usually has PS in it)
                if (outputReceived.Count > 10)
                {
                    break;
                }
            }
        }

        _output.WriteLine($"Total output received: {outputReceived.Count} bytes");
        Assert.True(outputReceived.Count > 0, "No output received from shell");
    }

    [Fact]
    public async Task ConHost_SendInput_ReceivesEcho()
    {
        _sessionId = GenerateSessionId();
        var pipeName = $"mm-con-{_sessionId}";

        _output.WriteLine($"Starting mmttyhost with session {_sessionId}");
        _conHostProcess = StartConHost(_sessionId);

        Assert.True(await WaitForPipeAsync(pipeName, TimeSpan.FromSeconds(5)), "Pipe not created");

        _pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await _pipe.ConnectAsync(5000);

        // GetInfo handshake
        await _pipe.WriteAsync(ConHostProtocol.CreateInfoRequest());
        var infoResponse = await ReadMessageAsync(_pipe, TimeSpan.FromSeconds(5));
        Assert.NotNull(infoResponse);
        _output.WriteLine("Handshake complete");

        // Wait for shell to be ready by polling GetBuffer until we see a prompt
        _output.WriteLine("Waiting for shell to be ready...");
        var readyDeadline = DateTime.UtcNow.AddSeconds(15);
        var shellReady = false;

        while (DateTime.UtcNow < readyDeadline && !shellReady)
        {
            await _pipe.WriteAsync(ConHostProtocol.CreateGetBuffer());
            var bufferResp = await ReadMessageAsync(_pipe, TimeSpan.FromSeconds(2));

            if (bufferResp?.type == ConHostMessageType.Buffer)
            {
                var bufferText = Encoding.UTF8.GetString(bufferResp.Value.payload.Span);
                _output.WriteLine($"Buffer check: {bufferText.Length} chars");

                // Look for shell prompt indicating shell is ready
                // cmd.exe: "C:\path>" (no trailing space after >)
                // pwsh: "PS C:\path> "
                if (bufferText.Contains("PS ") || bufferText.Contains(">"))
                {
                    shellReady = true;
                    _output.WriteLine("Shell is ready!");
                }
            }

            if (!shellReady)
            {
                await Task.Delay(500);
            }
        }

        Assert.True(shellReady, "Shell did not become ready in time");

        // Now send our marker command
        var marker = $"TEST{DateTime.UtcNow.Ticks % 100000}";
        var inputText = $"echo {marker}\r\n";
        var inputMsg = ConHostProtocol.CreateInputMessage(Encoding.UTF8.GetBytes(inputText));
        await _pipe.WriteAsync(inputMsg);
        _output.WriteLine($"Sent input: {inputText.Trim()}");

        // Collect output looking for our marker
        var allOutput = new StringBuilder();
        var deadline = DateTime.UtcNow.AddSeconds(10);

        while (DateTime.UtcNow < deadline)
        {
            var msg = await ReadMessageAsync(_pipe, TimeSpan.FromMilliseconds(200));
            if (msg is null) continue;

            if (msg.Value.type == ConHostMessageType.Output)
            {
                var text = Encoding.UTF8.GetString(msg.Value.payload.Span);
                allOutput.Append(text);
                _output.WriteLine($"Output chunk: {Escape(text)}");

                if (allOutput.ToString().Contains(marker))
                {
                    _output.WriteLine("Found marker in output!");
                    break;
                }
            }
        }

        var finalOutput = allOutput.ToString();
        _output.WriteLine($"Final output ({finalOutput.Length} chars): {Escape(finalOutput)}");

        Assert.Contains(marker, finalOutput);
    }

    [Fact]
    public async Task ConHost_WaitForPrompt_EventuallyReceivesOutput()
    {
        // This test waits a LONG time to verify the shell eventually outputs
        _sessionId = GenerateSessionId();
        var pipeName = $"mm-con-{_sessionId}";

        _output.WriteLine($"Starting mmttyhost with session {_sessionId}");
        _conHostProcess = StartConHost(_sessionId);

        Assert.True(await WaitForPipeAsync(pipeName, TimeSpan.FromSeconds(5)), "Pipe not created");

        _pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await _pipe.ConnectAsync(5000);

        // GetInfo handshake
        await _pipe.WriteAsync(ConHostProtocol.CreateInfoRequest());
        var infoResponse = await ReadMessageAsync(_pipe, TimeSpan.FromSeconds(5));
        Assert.NotNull(infoResponse);
        _output.WriteLine("Handshake complete, waiting for prompt (up to 30s)...");

        // Poll buffer until we see a prompt (30 seconds max)
        var deadline = DateTime.UtcNow.AddSeconds(30);
        var lastBufferLen = 0;

        while (DateTime.UtcNow < deadline)
        {
            await _pipe.WriteAsync(ConHostProtocol.CreateGetBuffer());
            var bufferResp = await ReadMessageAsync(_pipe, TimeSpan.FromSeconds(2));

            if (bufferResp?.type == ConHostMessageType.Buffer)
            {
                var bufferText = Encoding.UTF8.GetString(bufferResp.Value.payload.Span);

                if (bufferText.Length != lastBufferLen)
                {
                    _output.WriteLine($"Buffer: {bufferText.Length} chars - {Escape(bufferText[..Math.Min(50, bufferText.Length)])}...");
                    lastBufferLen = bufferText.Length;
                }

                // cmd.exe: "C:\Users\..>" or "Microsoft Windows"
                // pwsh: "PS C:\..."
                if (bufferText.Contains("PS ") || bufferText.Contains(">") || bufferText.Contains("Microsoft Windows"))
                {
                    _output.WriteLine($"SUCCESS! Got prompt after {(DateTime.UtcNow - deadline.AddSeconds(-30)).TotalSeconds:F1}s");
                    _output.WriteLine($"Full buffer ({bufferText.Length} chars): {Escape(bufferText)}");
                    return; // TEST PASSES
                }
            }

            await Task.Delay(500);
        }

        Assert.Fail("Prompt never appeared in buffer after 30 seconds");
    }

    [Fact]
    public async Task ConHost_GetBuffer_ReturnsAccumulatedOutput()
    {
        _sessionId = GenerateSessionId();
        var pipeName = $"mm-con-{_sessionId}";

        _conHostProcess = StartConHost(_sessionId);
        Assert.True(await WaitForPipeAsync(pipeName, TimeSpan.FromSeconds(5)), "Pipe not created");

        _pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await _pipe.ConnectAsync(5000);

        // GetInfo handshake
        await _pipe.WriteAsync(ConHostProtocol.CreateInfoRequest());
        var infoResponse = await ReadMessageAsync(_pipe, TimeSpan.FromSeconds(5));
        Assert.NotNull(infoResponse);

        // Wait for shell to produce some output
        await Task.Delay(2000);

        // Request buffer
        await _pipe.WriteAsync(ConHostProtocol.CreateGetBuffer());
        var bufferResponse = await ReadMessageAsync(_pipe, TimeSpan.FromSeconds(5));

        Assert.NotNull(bufferResponse);
        Assert.Equal(ConHostMessageType.Buffer, bufferResponse.Value.type);

        var bufferText = Encoding.UTF8.GetString(bufferResponse.Value.payload.Span);
        _output.WriteLine($"Buffer ({bufferText.Length} chars): {Escape(bufferText)}");

        Assert.True(bufferText.Length > 0, "Buffer should contain shell output");
    }

    private Process StartConHost(string sessionId, string shell = "cmd", bool redirectOutput = false)
    {
        var psi = new ProcessStartInfo
        {
            FileName = ConHostPath,
            Arguments = $"--session {sessionId} --shell {shell} --cols 80 --rows 24",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = redirectOutput,
            RedirectStandardError = redirectOutput
        };

        var process = Process.Start(psi)!;

        if (redirectOutput)
        {
            process.OutputDataReceived += (_, e) =>
            {
                if (e.Data is not null) _output.WriteLine($"[stdout] {e.Data}");
            };
            process.ErrorDataReceived += (_, e) =>
            {
                if (e.Data is not null) _output.WriteLine($"[stderr] {e.Data}");
            };
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
        }

        return process;
    }

    private static async Task<bool> WaitForPipeAsync(string pipeName, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;

        while (DateTime.UtcNow < deadline)
        {
            if (File.Exists($@"\\.\pipe\{pipeName}"))
            {
                return true;
            }
            await Task.Delay(100);
        }

        return false;
    }

    private static async Task<(ConHostMessageType type, Memory<byte> payload)?> ReadMessageAsync(
        NamedPipeClientStream pipe,
        TimeSpan timeout)
    {
        using var cts = new CancellationTokenSource(timeout);

        try
        {
            var headerBuffer = new byte[ConHostProtocol.HeaderSize];
            var bytesRead = await pipe.ReadAsync(headerBuffer, cts.Token);
            if (bytesRead == 0) return null;

            while (bytesRead < ConHostProtocol.HeaderSize)
            {
                var more = await pipe.ReadAsync(headerBuffer.AsMemory(bytesRead), cts.Token);
                if (more == 0) return null;
                bytesRead += more;
            }

            if (!ConHostProtocol.TryReadHeader(headerBuffer, out var msgType, out var payloadLength))
            {
                return null;
            }

            var payload = new byte[payloadLength];
            if (payloadLength > 0)
            {
                var totalRead = 0;
                while (totalRead < payloadLength)
                {
                    var chunk = await pipe.ReadAsync(payload.AsMemory(totalRead), cts.Token);
                    if (chunk == 0) return null;
                    totalRead += chunk;
                }
            }

            return (msgType, payload);
        }
        catch (OperationCanceledException)
        {
            return null;
        }
    }

    private static async Task DrainOutputAsync(NamedPipeClientStream pipe, TimeSpan duration)
    {
        var deadline = DateTime.UtcNow + duration;

        while (DateTime.UtcNow < deadline)
        {
            var msg = await ReadMessageAsync(pipe, TimeSpan.FromMilliseconds(100));
            if (msg is null) continue;
        }
    }

    private static string GenerateSessionId()
    {
        return Guid.NewGuid().ToString("N")[..8];
    }

    private static string FindConHostExe()
    {
        // Try various locations
        var candidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "Ai.Tlbx.MidTerm.TtyHost", "bin", "Debug", "net10.0", "win-x64", "mmttyhost.exe"),
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "Ai.Tlbx.MidTerm.TtyHost", "bin", "Release", "net10.0", "win-x64", "mmttyhost.exe"),
            @"C:\Program Files\MidTerm\mthost.exe",
        };

        foreach (var path in candidates)
        {
            var fullPath = Path.GetFullPath(path);
            if (File.Exists(fullPath))
            {
                return fullPath;
            }
        }

        // Return best guess for error message
        return Path.GetFullPath(candidates[0]);
    }

    private static string Escape(string s)
    {
        return s
            .Replace("\r", "\\r")
            .Replace("\n", "\\n")
            .Replace("\x1b", "\\e");
    }
}
