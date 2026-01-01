using System.Buffers;
using System.IO.Pipes;
using System.Text;
using Ai.Tlbx.MiddleManager.Host.Pty;
using Ai.Tlbx.MiddleManager.Host.Shells;

namespace Ai.Tlbx.MiddleManager.ConHost;

public static class Program
{
    public const string Version = "3.2.3";

    private static readonly string LogDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "MiddleManager", "logs");

    private static string? _sessionId;
    private static string? _logPath;
    private static bool _debugEnabled;

    public static async Task<int> Main(string[] args)
    {
        if (args.Contains("--version") || args.Contains("-v"))
        {
            Console.WriteLine($"mm-con-host {Version}");
            return 0;
        }

        if (args.Contains("--help") || args.Contains("-h"))
        {
            PrintHelp();
            return 0;
        }

        var config = ParseArgs(args);
        if (config is null)
        {
            Console.Error.WriteLine("Missing required arguments. Use --help for usage.");
            return 1;
        }

        _sessionId = config.SessionId;
        _logPath = Path.Combine(LogDir, $"mm-con-{_sessionId}.log");
        _debugEnabled = config.Debug;

        Log($"mm-con-host {Version} starting for session {config.SessionId}");

        try
        {
            await RunAsync(config).ConfigureAwait(false);
            return 0;
        }
        catch (Exception ex)
        {
            Log($"Fatal error: {ex}");
            return 1;
        }
    }

    private static async Task RunAsync(SessionConfig config)
    {
        var shellRegistry = new ShellRegistry();
        var shellConfig = shellRegistry.GetConfigurationByName(config.ShellType)
            ?? shellRegistry.GetConfigurationOrDefault(null);

        Log($"Starting shell: {shellConfig.ShellType} ({shellConfig.ExecutablePath})");

        IPtyConnection? pty = null;
        try
        {
            pty = PtyConnectionFactory.Create(
                shellConfig.ExecutablePath,
                shellConfig.Arguments,
                config.WorkingDirectory,
                config.Cols,
                config.Rows,
                shellConfig.GetEnvironmentVariables());

            Log($"PTY started, PID: {pty.Pid}");

            var session = new TerminalSession(config.SessionId, pty, shellConfig.ShellType, config.Cols, config.Rows);

            var pipeName = ConHostProtocol.GetPipeName(config.SessionId);
            Log($"Listening on pipe: {pipeName}");

            using var cts = new CancellationTokenSource();

            // Start PTY read loop
            var ptyReadTask = session.StartReadLoopAsync(cts.Token);

            // Accept client connections (mm.exe)
            await AcceptClientsAsync(session, pipeName, cts.Token).ConfigureAwait(false);

            cts.Cancel();
            await ptyReadTask.ConfigureAwait(false);
        }
        finally
        {
            pty?.Dispose();
            Log("Shutdown complete");
        }
    }

    // Track current client to disconnect when a new one connects
    private static CancellationTokenSource? _currentClientCts;
    private static readonly object _clientLock = new();

    private static async Task AcceptClientsAsync(TerminalSession session, string pipeName, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && session.IsRunning)
        {
            try
            {
                var pipe = new NamedPipeServerStream(
                    pipeName,
                    PipeDirection.InOut,
                    NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);

                Log("Waiting for client connection...");
                await pipe.WaitForConnectionAsync(ct).ConfigureAwait(false);
                Log("Client connected");

                // Cancel any existing client - only one active client per session
                lock (_clientLock)
                {
                    _currentClientCts?.Cancel();
                    _currentClientCts?.Dispose();
                    _currentClientCts = new CancellationTokenSource();
                }

                var clientCt = CancellationTokenSource.CreateLinkedTokenSource(ct, _currentClientCts!.Token).Token;
                _ = HandleClientAsync(session, pipe, clientCt);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Log($"Accept error: {ex.Message}");
                await Task.Delay(100, ct).ConfigureAwait(false);
            }
        }
    }

    private static async Task HandleClientAsync(TerminalSession session, NamedPipeServerStream pipe, CancellationToken ct)
    {
        var pendingOutput = new List<byte[]>();
        var outputLock = new object();
        var handshakeComplete = false;

        try
        {
            void OnOutput(ReadOnlyMemory<byte> data)
            {
                try
                {
                    lock (outputLock)
                    {
                        if (!handshakeComplete)
                        {
                            // Buffer output until handshake completes
                            if (data.Length < 50)
                            {
                                DebugLog($"[BUFFER] Buffering {data.Length} bytes (handshake pending)");
                            }
                            pendingOutput.Add(data.ToArray());
                            return;
                        }
                    }

                    if (pipe.IsConnected)
                    {
                        var msg = ConHostProtocol.CreateOutputMessage(session.Cols, session.Rows, data.Span);
                        Log($"Writing output: type=0x{msg[0]:X2}, len={BitConverter.ToInt32(msg, 1)}, total={msg.Length}");
                        lock (pipe)
                        {
                            pipe.Write(msg);
                            pipe.Flush();
                        }
                    }
                    else
                    {
                        DebugLog($"[PIPE-OUTPUT] Pipe not connected, discarding {data.Length} bytes");
                    }
                }
                catch (Exception ex)
                {
                    Log($"Output write failed: {ex.Message}");
                }
            }

            void OnStateChange()
            {
                try
                {
                    if (pipe.IsConnected)
                    {
                        var msg = ConHostProtocol.CreateStateChange(session.IsRunning, session.ExitCode);
                        lock (pipe)
                        {
                            pipe.Write(msg);
                            pipe.Flush();
                        }
                    }
                }
                catch { }
            }

            void OnHandshakeComplete()
            {
                lock (outputLock)
                {
                    handshakeComplete = true;
                    DebugLog($"[HANDSHAKE] Complete, pipe connected: {pipe.IsConnected}");

                    // Send any buffered output (buffered before handshake, all at same initial dimensions)
                    if (pendingOutput.Count > 0)
                    {
                        Log($"Flushing {pendingOutput.Count} buffered output chunks");
                        foreach (var data in pendingOutput)
                        {
                            try
                            {
                                if (pipe.IsConnected)
                                {
                                    var msg = ConHostProtocol.CreateOutputMessage(session.Cols, session.Rows, data);
                                    Log($"Writing buffered: type=0x{msg[0]:X2}, len={BitConverter.ToInt32(msg, 1)}, total={msg.Length}");
                                    lock (pipe)
                                    {
                                        pipe.Write(msg);
                                        pipe.Flush();
                                    }
                                }
                            }
                            catch (Exception ex)
                            {
                                Log($"Buffered output write failed: {ex.Message}");
                            }
                        }
                        pendingOutput.Clear();
                    }
                }
            }

            session.OnOutput += OnOutput;
            // Don't subscribe to OnStateChanged until after handshake - OSC-7 during startup
            // can fire StateChange before Info response, breaking the handshake

            try
            {
                await ProcessMessagesAsync(session, pipe, ct, () =>
                {
                    OnHandshakeComplete();
                    session.OnStateChanged += OnStateChange; // Subscribe after handshake
                }).ConfigureAwait(false);
            }
            finally
            {
                session.OnOutput -= OnOutput;
                session.OnStateChanged -= OnStateChange;
            }
        }
        catch (Exception ex)
        {
            Log($"Client handler error: {ex.Message}");
        }
        finally
        {
            try { pipe.Dispose(); } catch { }
            Log("Client disconnected");
        }
    }

    private static async Task ProcessMessagesAsync(TerminalSession session, NamedPipeServerStream pipe, CancellationToken ct, Action? onHandshakeComplete = null)
    {
        var headerBuffer = new byte[ConHostProtocol.HeaderSize];
        var payloadBuffer = new byte[ConHostProtocol.MaxPayloadSize];

        while (!ct.IsCancellationRequested && pipe.IsConnected)
        {
            // Read header
            var bytesRead = await pipe.ReadAsync(headerBuffer, ct).ConfigureAwait(false);
            if (bytesRead == 0)
            {
                break;
            }

            if (bytesRead < ConHostProtocol.HeaderSize)
            {
                // Read remaining header bytes
                var remaining = ConHostProtocol.HeaderSize - bytesRead;
                var more = await pipe.ReadAsync(headerBuffer.AsMemory(bytesRead, remaining), ct).ConfigureAwait(false);
                if (more == 0) break;
                bytesRead += more;
            }

            if (!ConHostProtocol.TryReadHeader(headerBuffer, out var msgType, out var payloadLength))
            {
                Log("Invalid message header");
                break;
            }

            // Read payload
            if (payloadLength > 0)
            {
                if (payloadLength > ConHostProtocol.MaxPayloadSize)
                {
                    Log($"Payload too large: {payloadLength}");
                    break;
                }

                var totalRead = 0;
                while (totalRead < payloadLength)
                {
                    var chunk = await pipe.ReadAsync(payloadBuffer.AsMemory(totalRead, payloadLength - totalRead), ct).ConfigureAwait(false);
                    if (chunk == 0) break;
                    totalRead += chunk;
                }

                if (totalRead < payloadLength)
                {
                    break;
                }
            }

            var payload = payloadBuffer.AsSpan(0, payloadLength);

            // Process message
            switch (msgType)
            {
                case ConHostMessageType.GetInfo:
                    var info = session.GetInfo();
                    var infoMsg = ConHostProtocol.CreateInfoResponse(info);
                    Log($"Writing Info response: type=0x{infoMsg[0]:X2}, len={BitConverter.ToInt32(infoMsg, 1)}, total={infoMsg.Length}");
                    lock (pipe)
                    {
                        pipe.Write(infoMsg);
                        pipe.Flush();
                    }
                    // Signal that handshake is complete - safe to start sending output
                    onHandshakeComplete?.Invoke();
                    break;

                case ConHostMessageType.Input:
                    if (payloadLength < 20)
                    {
                        DebugLog($"[PIPE-INPUT] {BitConverter.ToString(payload.ToArray())}");
                    }
                    await session.SendInputAsync(payload.ToArray(), ct).ConfigureAwait(false);
                    break;

                case ConHostMessageType.Resize:
                    var (cols, rows) = ConHostProtocol.ParseResize(payload);
                    session.Resize(cols, rows);
                    var resizeAck = ConHostProtocol.CreateResizeAck();
                    lock (pipe)
                    {
                        pipe.Write(resizeAck);
                        pipe.Flush();
                    }
                    break;

                case ConHostMessageType.GetBuffer:
                    var buffer = session.GetBuffer();
                    var bufferMsg = ConHostProtocol.CreateBufferResponse(buffer);
                    lock (pipe)
                    {
                        pipe.Write(bufferMsg);
                        pipe.Flush();
                    }
                    break;

                case ConHostMessageType.SetName:
                    var name = ConHostProtocol.ParseSetName(payload);
                    session.SetName(string.IsNullOrEmpty(name) ? null : name);
                    var nameAck = ConHostProtocol.CreateSetNameAck();
                    lock (pipe)
                    {
                        pipe.Write(nameAck);
                        pipe.Flush();
                    }
                    break;

                case ConHostMessageType.Close:
                    Log("Received close request, shutting down");
                    var closeAck = ConHostProtocol.CreateCloseAck();
                    lock (pipe)
                    {
                        pipe.Write(closeAck);
                        pipe.Flush();
                    }
                    session.Kill();
                    // Exit the entire process - AcceptClientsAsync is stuck on WaitForConnectionAsync
                    Environment.Exit(0);
                    return;

                default:
                    Log($"Unknown message type: {msgType}");
                    break;
            }
        }
    }

    private static SessionConfig? ParseArgs(string[] args)
    {
        string? sessionId = null;
        string? shellType = null;
        string? workingDir = null;
        int cols = 80;
        int rows = 24;
        bool debug = false;

        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--session" when i + 1 < args.Length:
                    sessionId = args[++i];
                    break;
                case "--shell" when i + 1 < args.Length:
                    shellType = args[++i];
                    break;
                case "--cwd" when i + 1 < args.Length:
                    workingDir = args[++i];
                    break;
                case "--cols" when i + 1 < args.Length && int.TryParse(args[i + 1], out var c):
                    cols = c;
                    i++;
                    break;
                case "--rows" when i + 1 < args.Length && int.TryParse(args[i + 1], out var r):
                    rows = r;
                    i++;
                    break;
                case "--debug":
                    debug = true;
                    break;
            }
        }

        if (string.IsNullOrEmpty(sessionId))
        {
            return null;
        }

        workingDir ??= Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        return new SessionConfig(sessionId, shellType, workingDir, cols, rows, debug);
    }

    private static void PrintHelp()
    {
        Console.WriteLine($"""
            mm-con-host {Version} - MiddleManager Console Host

            Usage: mm-con-host --session <id> [options]

            Required:
              --session <id>    Unique session identifier

            Options:
              --shell <type>    Shell type (pwsh, cmd, bash, zsh)
              --cwd <path>      Working directory
              --cols <n>        Terminal columns (default: 80)
              --rows <n>        Terminal rows (default: 24)
              -h, --help        Show this help
              -v, --version     Show version

            IPC:
              Listens on named pipe: mm-con-<session-id>
            """);
    }

    internal static void Log(string message)
    {
        var line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}] [{_sessionId}] {message}";
        Console.WriteLine(line);
        try
        {
            Directory.CreateDirectory(LogDir);
            File.AppendAllText(_logPath!, line + Environment.NewLine);
        }
        catch { }
    }

    internal static void DebugLog(string message)
    {
        if (!_debugEnabled) return;
        Log(message);
    }

    private sealed record SessionConfig(string SessionId, string? ShellType, string WorkingDirectory, int Cols, int Rows, bool Debug);
}

internal sealed class TerminalSession
{
    private readonly IPtyConnection _pty;
    private readonly StringBuilder _outputBuffer = new();
    private readonly object _bufferLock = new();
    private const int MaxBufferSize = 100_000;

    public string Id { get; }
    public ShellType ShellType { get; }
    public int Cols { get; private set; }
    public int Rows { get; private set; }
    public string? Name { get; private set; }
    public string? CurrentWorkingDirectory { get; private set; }
    public DateTime CreatedAt { get; } = DateTime.UtcNow;

    public int Pid => _pty.Pid;
    public bool IsRunning => _pty.IsRunning;
    public int? ExitCode => _pty.ExitCode;

    public event Action<ReadOnlyMemory<byte>>? OnOutput;
    public event Action? OnStateChanged;

    public TerminalSession(string id, IPtyConnection pty, ShellType shellType, int cols, int rows)
    {
        Id = id;
        _pty = pty;
        ShellType = shellType;
        Cols = cols;
        Rows = rows;
    }

    public async Task StartReadLoopAsync(CancellationToken ct)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(8192);
        try
        {
            while (!ct.IsCancellationRequested)
            {
                int bytesRead;
                try
                {
                    bytesRead = await _pty.ReaderStream.ReadAsync(buffer, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (IOException)
                {
                    break;
                }

                if (bytesRead == 0)
                {
                    break;
                }

                var data = buffer.AsMemory(0, bytesRead);
                if (bytesRead < 50)
                {
                    Program.DebugLog($"[PTY-READ] {BitConverter.ToString(data.ToArray())}");
                }
                AppendToBuffer(data.Span);
                ParseOscSequences(data.Span);
                OnOutput?.Invoke(data);
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
            OnStateChanged?.Invoke();
        }
    }

    public async Task SendInputAsync(byte[] data, CancellationToken ct)
    {
        if (data.Length < 20)
        {
            Program.DebugLog($"[PTY-WRITE] {BitConverter.ToString(data)}");
        }
        await _pty.WriterStream.WriteAsync(data, ct).ConfigureAwait(false);
        await _pty.WriterStream.FlushAsync(ct).ConfigureAwait(false);
    }

    public void Resize(int cols, int rows)
    {
        if (Cols == cols && Rows == rows) return;
        Cols = cols;
        Rows = rows;
        _pty.Resize(cols, rows);
        OnStateChanged?.Invoke();
    }

    public void SetName(string? name)
    {
        Name = name;
        OnStateChanged?.Invoke();
    }

    public byte[] GetBuffer()
    {
        lock (_bufferLock)
        {
            return Encoding.UTF8.GetBytes(_outputBuffer.ToString());
        }
    }

    public SessionInfo GetInfo()
    {
        return new SessionInfo
        {
            Id = Id,
            Pid = Pid,
            ShellType = ShellType.ToString(),
            Cols = Cols,
            Rows = Rows,
            IsRunning = IsRunning,
            ExitCode = ExitCode,
            CurrentWorkingDirectory = CurrentWorkingDirectory,
            Name = Name,
            CreatedAt = CreatedAt
        };
    }

    public void Kill()
    {
        _pty.Kill();
    }

    private void AppendToBuffer(ReadOnlySpan<byte> data)
    {
        var text = Encoding.UTF8.GetString(data);
        lock (_bufferLock)
        {
            _outputBuffer.Append(text);
            if (_outputBuffer.Length > MaxBufferSize)
            {
                _outputBuffer.Remove(0, _outputBuffer.Length - MaxBufferSize);
            }
        }
    }

    private void ParseOscSequences(ReadOnlySpan<byte> data)
    {
        var text = Encoding.UTF8.GetString(data);
        var path = ParseOsc7Path(text);
        if (path is not null && CurrentWorkingDirectory != path)
        {
            CurrentWorkingDirectory = path;
            OnStateChanged?.Invoke();
        }
    }

    private static string? ParseOsc7Path(string text)
    {
        var oscStart = text.IndexOf("\x1b]7;", StringComparison.Ordinal);
        if (oscStart < 0) return null;

        var uriStart = oscStart + 4;
        var oscEnd = text.IndexOfAny(['\x07', '\x1b'], uriStart);
        if (oscEnd <= uriStart) return null;

        var uri = text.Substring(uriStart, oscEnd - uriStart);
        if (!uri.StartsWith("file://", StringComparison.OrdinalIgnoreCase)) return null;

        try
        {
            var pathStart = uri.IndexOf('/', 7);
            if (pathStart < 0) return null;

            var path = Uri.UnescapeDataString(uri.Substring(pathStart));
            if (path.Length > 2 && path[0] == '/' && path[2] == ':')
            {
                path = path.Substring(1);
            }
            return path;
        }
        catch
        {
            return null;
        }
    }
}
