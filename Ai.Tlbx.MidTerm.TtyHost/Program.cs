using System.Buffers;
using System.Runtime.InteropServices;
using System.Text;
#if WINDOWS
using Microsoft.Win32.SafeHandles;
using System.IO.Pipes;
#else
using System.Net.Sockets;
#endif
using Ai.Tlbx.MidTerm.Common.Ipc;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Process;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Common.Shells;
using Ai.Tlbx.MidTerm.TtyHost.Ipc;
using Ai.Tlbx.MidTerm.TtyHost.Process;
using Ai.Tlbx.MidTerm.TtyHost.Pty;

namespace Ai.Tlbx.MidTerm.TtyHost;

public static class Program
{
#if WINDOWS
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool PeekNamedPipe(
        SafePipeHandle hNamedPipe,
        IntPtr lpBuffer,
        uint nBufferSize,
        IntPtr lpBytesRead,
        out uint lpTotalBytesAvail,
        IntPtr lpBytesLeftThisMessage);
#endif

    private const int HeartbeatIntervalMs = 5000;
    private const int ReadTimeoutMs = 10000;

    private static CancellationTokenSource? _shutdownCts;

    public static async Task<int> Main(string[] args)
    {
#if !WINDOWS
        // PTY exec mode - check FIRST before any .NET initialization
        // Usage: mthost --pty-exec <slave-path> <shell> [shell-args...]
        // This replaces the process with the shell via execvp() and never returns
        if (args.Length >= 3 && args[0] == "--pty-exec")
        {
            return PtyExec.Execute(args[1], args[2..]);
        }
#endif

        if (args.Contains("--version") || args.Contains("-v"))
        {
            Console.WriteLine($"mthost {VersionInfo.Version}");
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

        var logDirectory = LogPaths.GetLogDirectory(isWindowsService: false);
        Log.Initialize($"mthost-{config.SessionId}", logDirectory, config.LogSeverity);

#if !WINDOWS
        // Register Unix signal handlers for graceful shutdown
        PosixSignalRegistration.Create(PosixSignal.SIGTERM, OnSignal);
        PosixSignalRegistration.Create(PosixSignal.SIGINT, OnSignal);
#endif

        Log.Info(() => $"mthost {VersionInfo.Version} starting, session={config.SessionId}");

        try
        {
            await RunAsync(config).ConfigureAwait(false);
            return 0;
        }
        catch (Exception ex)
        {
            Log.Exception(ex, "Fatal error");
            return 1;
        }
        finally
        {
            Log.Shutdown();
        }
    }

    private static async Task RunAsync(SessionConfig config)
    {
        var shellRegistry = new ShellRegistry();
        var shellConfig = shellRegistry.GetConfigurationByName(config.ShellType)
            ?? shellRegistry.GetConfigurationOrDefault(null);

        IPtyConnection? pty = null;
        IProcessMonitor? processMonitor = null;
        try
        {
            pty = PtyConnectionFactory.Create(
                shellConfig.ExecutablePath,
                shellConfig.Arguments,
                config.WorkingDirectory,
                config.Cols,
                config.Rows,
                shellConfig.GetEnvironmentVariables());

            processMonitor = CreateProcessMonitor();
            var session = new TerminalSession(config.SessionId, pty, shellConfig.ShellType, config.Cols, config.Rows, processMonitor);
            var endpoint = IpcEndpoint.GetSessionEndpoint(config.SessionId, Environment.ProcessId);
            Log.Info(() => $"PTY ready, PID={pty.Pid}, endpoint={endpoint}");

            if (processMonitor is not null)
            {
                processMonitor.StartMonitoring(pty.Pid);
                Log.Info(() => $"Process monitor started for PID={pty.Pid}");
            }

            using var cts = new CancellationTokenSource();
            _shutdownCts = cts;
            Task? ptyReadTask = null;

            // Accept client connections (mt.exe)
            // The read loop is started by the first client that connects
            await AcceptClientsAsync(session, endpoint, cts.Token, () =>
            {
                if (ptyReadTask is null)
                {
                    ptyReadTask = session.StartReadLoopAsync(cts.Token);
                }
            }).ConfigureAwait(false);

            cts.Cancel();
            if (ptyReadTask is not null)
            {
                await ptyReadTask.ConfigureAwait(false);
            }
        }
        finally
        {
            processMonitor?.StopMonitoring();
            processMonitor?.Dispose();
            pty?.Dispose();
        }
    }

    private static IProcessMonitor? CreateProcessMonitor()
    {
        try
        {
#if WINDOWS
#pragma warning disable CA1416 // Platform compatibility - guarded by #if WINDOWS
            return new WindowsProcessMonitor();
#pragma warning restore CA1416
#elif LINUX
            return new LinuxProcessMonitor();
#elif MACOS
            return new MacOSProcessMonitor();
#else
            return null;
#endif
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"Failed to create process monitor: {ex.Message}");
            return null;
        }
    }

    // Track current client to disconnect when a new one connects
    private static CancellationTokenSource? _currentClientCts;
    private static readonly object _clientLock = new();

    private static async Task AcceptClientsAsync(TerminalSession session, string endpoint, CancellationToken ct, Action? onFirstClientSubscribed = null)
    {
        var firstClientSubscribed = false;
        var connectionCount = 0;

        using var server = IpcServerFactory.Create(endpoint);

        while (!ct.IsCancellationRequested && session.IsRunning)
        {
            try
            {
                var client = await server.AcceptAsync(ct).ConfigureAwait(false);
                connectionCount++;
                Log.Info(() => $"Client connected (#{connectionCount})");

                // Cancel any existing client - only one active client per session
                // Don't dispose immediately - let GC handle it to avoid race conditions
                // with linked token registrations
                CancellationTokenSource clientCts;
                lock (_clientLock)
                {
                    _currentClientCts?.Cancel();
                    _currentClientCts = new CancellationTokenSource();
                    clientCts = _currentClientCts;
                }

                // Create a linked CTS that combines shutdown token with this client's token
                // This is created outside the lock and passed directly to HandleClientAsync
                using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(ct, clientCts.Token);
                var clientToken = linkedCts.Token;

                // Start the read loop when the first client subscribes to output
                Action? onSubscribed = null;
                if (!firstClientSubscribed && onFirstClientSubscribed is not null)
                {
                    onSubscribed = () =>
                    {
                        if (!firstClientSubscribed)
                        {
                            firstClientSubscribed = true;
                            onFirstClientSubscribed();
                        }
                    };
                }

                // Run HandleClientAsync synchronously (don't fire-and-forget)
                // This ensures the linked CTS stays alive for the duration of the handler
                await HandleClientAsync(session, client, clientToken, onSubscribed).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Log.Error(() => $"Accept error: {ex.Message}");
                Log.Exception(ex, "AcceptClients");
                await Task.Delay(100, ct).ConfigureAwait(false);
            }
        }
    }

    private static async Task HandleClientAsync(TerminalSession session, IIpcClientConnection client, CancellationToken ct, Action? onSubscribed = null)
    {
        const int MaxPendingOutputSize = 1_000_000; // 1MB max during handshake
        var pendingOutput = new List<byte[]>();
        var pendingOutputSize = 0;
        var outputLock = new object();
        var handshakeComplete = false;
        var stream = client.Stream;

        // CTS that heartbeat can cancel to terminate message processing
        using var clientCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var heartbeatTask = HeartbeatLoopAsync(client, clientCts);

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
                            // Buffer output until handshake completes (bounded)
                            if (pendingOutputSize < MaxPendingOutputSize)
                            {
                                if (data.Length < 50)
                                {
                                    Log.Verbose(() => $"[BUFFER] Buffering {data.Length} bytes (handshake pending)");
                                }
                                var copy = data.ToArray();
                                pendingOutput.Add(copy);
                                pendingOutputSize += copy.Length;
                            }
                            else
                            {
                                Log.Warn(() => $"Warning: dropping {data.Length} bytes during handshake (buffer full: {pendingOutputSize}/{MaxPendingOutputSize})");
                            }
                            return;
                        }
                    }

                    if (client.IsConnected)
                    {
                        var msg = TtyHostProtocol.CreateOutputMessage(session.Cols, session.Rows, data.Span);
                        lock (stream)
                        {
                            stream.Write(msg);
                            stream.Flush();
                        }
                    }
                    else
                    {
                        Log.Verbose(() => $"[IPC-OUTPUT] Client not connected, discarding {data.Length} bytes");
                    }
                }
                catch (Exception ex)
                {
                    Log.Error(() => $"Output write failed: {ex.Message}");
                    Log.Exception(ex, "OnOutput.Write");
                }
            }

            void OnStateChange()
            {
                try
                {
                    if (client.IsConnected)
                    {
                        var msg = TtyHostProtocol.CreateStateChange(session.IsRunning, session.ExitCode);
                        lock (stream)
                        {
                            stream.Write(msg);
                            stream.Flush();
                        }
                    }
                }
                catch (Exception ex) { Log.Exception(ex, "OnStateChange"); }
            }

            void OnProcessEvent(ProcessEvent evt)
            {
                try
                {
                    if (client.IsConnected && handshakeComplete)
                    {
                        var payload = new ProcessEventPayload
                        {
                            Type = evt.Type,
                            Pid = evt.Pid,
                            ParentPid = evt.ParentPid,
                            Name = evt.Name,
                            CommandLine = evt.CommandLine,
                            ExitCode = evt.ExitCode,
                            Timestamp = evt.Timestamp
                        };
                        var msg = TtyHostProtocol.CreateProcessEvent(payload);
                        lock (stream)
                        {
                            stream.Write(msg);
                            stream.Flush();
                        }
                    }
                }
                catch (Exception ex) { Log.Exception(ex, "OnProcessEvent"); }
            }

            void OnForegroundChanged(ForegroundProcessInfo info)
            {
                try
                {
                    if (client.IsConnected && handshakeComplete)
                    {
                        var payload = new ForegroundChangePayload
                        {
                            Pid = info.Pid,
                            Name = info.Name,
                            CommandLine = info.CommandLine,
                            Cwd = info.Cwd
                        };
                        var msg = TtyHostProtocol.CreateForegroundChange(payload);
                        lock (stream)
                        {
                            stream.Write(msg);
                            stream.Flush();
                        }
                    }
                }
                catch (Exception ex) { Log.Exception(ex, "OnForegroundChanged"); }
            }

            void OnHandshakeComplete()
            {
                lock (outputLock)
                {
                    handshakeComplete = true;
                    Log.Verbose(() => $"[HANDSHAKE] Complete, client connected: {client.IsConnected}");

                    // Send any buffered output (buffered before handshake, all at same initial dimensions)
                    if (pendingOutput.Count > 0)
                    {
                        foreach (var data in pendingOutput)
                        {
                            try
                            {
                                if (client.IsConnected)
                                {
                                    var msg = TtyHostProtocol.CreateOutputMessage(session.Cols, session.Rows, data);
                                    lock (stream)
                                    {
                                        stream.Write(msg);
                                        stream.Flush();
                                    }
                                }
                            }
                            catch (Exception ex)
                            {
                                Log.Error(() => $"Buffered output write failed: {ex.Message}");
                                Log.Exception(ex, "OnHandshakeComplete.BufferedWrite");
                            }
                        }
                        pendingOutput.Clear();
                    }
                }
            }

            session.OnOutput += OnOutput;
            onSubscribed?.Invoke(); // Notify that we're subscribed - read loop can start now

            // Don't subscribe to OnStateChanged until after handshake - OSC-7 during startup
            // can fire StateChange before Info response, breaking the handshake
            var stateChangeSubscribed = false;

            try
            {
                await ProcessMessagesAsync(session, stream, clientCts.Token, () =>
                {
                    OnHandshakeComplete();
                    // Only subscribe once - repeated GetInfo requests must not add duplicate handlers
                    // (duplicate handlers cause exponential StateChange message growth)
                    if (!stateChangeSubscribed)
                    {
                        stateChangeSubscribed = true;
                        session.OnStateChanged += OnStateChange;
                        session.OnProcessEvent += OnProcessEvent;
                        session.OnForegroundChanged += OnForegroundChanged;
                    }
                }).ConfigureAwait(false);
            }
            finally
            {
                session.OnOutput -= OnOutput;
                session.OnStateChanged -= OnStateChange;
                session.OnProcessEvent -= OnProcessEvent;
                session.OnForegroundChanged -= OnForegroundChanged;
            }
        }
        catch (Exception ex)
        {
            Log.Error(() => $"Client handler error: {ex.Message}");
            Log.Exception(ex, "HandleClient");
        }
        finally
        {
            clientCts.Cancel();
            // Await heartbeat completion; exceptions are expected during cancellation
            try { await heartbeatTask.ConfigureAwait(false); } catch { }
            try { client.Dispose(); }
            catch (Exception disposeEx) { Log.Exception(disposeEx, "HandleClient.ClientDispose"); }
            Log.Info(() => "Client disconnected");
        }
    }

    private static async Task HeartbeatLoopAsync(IIpcClientConnection client, CancellationTokenSource clientCts)
    {
        var ct = clientCts.Token;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(HeartbeatIntervalMs, ct).ConfigureAwait(false);

                if (!client.IsConnected)
                {
                    Log.Info(() => "Heartbeat: client disconnected");
                    clientCts.Cancel();
                    break;
                }

#if WINDOWS
                // Use PeekNamedPipe for instant stale detection on Windows
                if (client.Stream is NamedPipeServerStream pipe)
                {
                    try
                    {
                        var handle = pipe.SafePipeHandle;
                        if (!PeekNamedPipe(handle, IntPtr.Zero, 0, IntPtr.Zero, out _, IntPtr.Zero))
                        {
                            var error = Marshal.GetLastWin32Error();
                            Log.Warn(() => $"Heartbeat: PeekNamedPipe failed (error {error}) - pipe stale");
                            clientCts.Cancel();
                            break;
                        }
                    }
                    catch (ObjectDisposedException)
                    {
                        clientCts.Cancel();
                        break;
                    }
                }
#else
                // On Unix, check socket state
                if (client.Stream is NetworkStream ns)
                {
                    try
                    {
                        var socket = ns.Socket;
                        if (socket.Poll(0, SelectMode.SelectError))
                        {
                            Log.Warn(() => "Heartbeat: socket error detected");
                            clientCts.Cancel();
                            break;
                        }
                    }
                    catch
                    {
                        clientCts.Cancel();
                        break;
                    }
                }
#endif
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Log.Error(() => $"Heartbeat error: {ex.Message}");
            }
        }
    }

    private static async Task ProcessMessagesAsync(TerminalSession session, Stream stream, CancellationToken ct, Action? onHandshakeComplete = null)
    {
        var headerBuffer = new byte[TtyHostProtocol.HeaderSize];

        while (!ct.IsCancellationRequested)
        {
            int bytesRead;
            try
            {
                bytesRead = await stream.ReadAsync(headerBuffer, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                Log.Error(() => $"IPC read error: {ex.Message}");
                break;
            }

            if (bytesRead == 0)
            {
                break;
            }

            if (bytesRead < TtyHostProtocol.HeaderSize)
            {
                // Read remaining header bytes
                var remaining = TtyHostProtocol.HeaderSize - bytesRead;
                var more = await stream.ReadAsync(headerBuffer.AsMemory(bytesRead, remaining), ct).ConfigureAwait(false);
                if (more == 0) break;
                bytesRead += more;
            }

            if (!TtyHostProtocol.TryReadHeader(headerBuffer, out var msgType, out var payloadLength))
            {
                Log.Warn(() => "Invalid message header");
                break;
            }

            // Read payload - allocate dynamically based on actual size
            byte[] payloadBuffer = [];
            if (payloadLength > 0)
            {
                payloadBuffer = new byte[payloadLength];
                var totalRead = 0;
                while (totalRead < payloadLength)
                {
                    var chunk = await stream.ReadAsync(payloadBuffer.AsMemory(totalRead, payloadLength - totalRead), ct).ConfigureAwait(false);
                    if (chunk == 0) break;
                    totalRead += chunk;
                }

                if (totalRead < payloadLength)
                {
                    break;
                }
            }

            var payload = payloadBuffer.AsSpan(0, payloadLength);

            // Process message - wrap in try-catch for robustness
            try
            {
                switch (msgType)
                {
                    case TtyHostMessageType.GetInfo:
                        var info = session.GetInfo();
                        var infoMsg = TtyHostProtocol.CreateInfoResponse(info);
                        lock (stream)
                        {
                            stream.Write(infoMsg);
                            stream.Flush();
                        }
                        onHandshakeComplete?.Invoke();
                        break;

                    case TtyHostMessageType.Input:
                        var inputData = payload.ToArray();
                        if (inputData.Length < 20)
                        {
                            Log.Verbose(() => $"[IPC-INPUT] {BitConverter.ToString(inputData)}");
                        }
                        await session.SendInputAsync(inputData, ct).ConfigureAwait(false);
                        break;

                    case TtyHostMessageType.Resize:
                        var (cols, rows) = TtyHostProtocol.ParseResize(payload);
                        session.Resize(cols, rows);
                        var resizeAck = TtyHostProtocol.CreateResizeAck();
                        lock (stream)
                        {
                            stream.Write(resizeAck);
                            stream.Flush();
                        }
                        break;

                    case TtyHostMessageType.GetBuffer:
                        var buffer = session.GetBuffer();
                        var bufferMsg = TtyHostProtocol.CreateBufferResponse(buffer);
                        lock (stream)
                        {
                            stream.Write(bufferMsg);
                            stream.Flush();
                        }
                        break;

                    case TtyHostMessageType.SetName:
                        var name = TtyHostProtocol.ParseSetName(payload);
                        session.SetName(string.IsNullOrEmpty(name) ? null : name);
                        var nameAck = TtyHostProtocol.CreateSetNameAck();
                        lock (stream)
                        {
                            stream.Write(nameAck);
                            stream.Flush();
                        }
                        break;

                    case TtyHostMessageType.SetLogLevel:
                        var newLevel = TtyHostProtocol.ParseSetLogLevel(payload);
                        Log.Info(() => $"Log level changed via IPC: {Log.MinLevel} -> {newLevel}");
                        Log.MinLevel = newLevel;
                        var levelAck = TtyHostProtocol.CreateSetLogLevelAck();
                        lock (stream)
                        {
                            stream.Write(levelAck);
                            stream.Flush();
                        }
                        break;

                    case TtyHostMessageType.Close:
                        Log.Info(() => "Received close request, shutting down");
                        var closeAck = TtyHostProtocol.CreateCloseAck();
                        lock (stream)
                        {
                            stream.Write(closeAck);
                            stream.Flush();
                        }
                        session.Kill();
                        // Signal graceful shutdown - let finally blocks run
                        _shutdownCts?.Cancel();
                        return;

                    default:
                        Log.Warn(() => $"Unknown message type: {msgType}");
                        break;
                }
            }
            catch (Exception ex) when (msgType != TtyHostMessageType.Close)
            {
                Log.Error(() => $"Error processing message type {msgType}: {ex.Message}");
                Log.Exception(ex, $"ProcessMessage.{msgType}");
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
        var logLevel = LogSeverity.Warn;

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
                case "--loglevel" when i + 1 < args.Length && Enum.TryParse<LogSeverity>(args[i + 1], ignoreCase: true, out var level):
                    logLevel = level;
                    i++;
                    break;
                case "--debug":
                    logLevel = LogSeverity.Verbose;
                    break;
            }
        }

        sessionId ??= Environment.ProcessId.ToString();
        workingDir ??= Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        return new SessionConfig(sessionId, shellType, workingDir, cols, rows, logLevel);
    }

    private static void PrintHelp()
    {
        Console.WriteLine($"""
            mthost {VersionInfo.Version} - MidTerm Console Host

            Usage: mthost --session <id> [options]
                   mthost --pty-exec <slave-path> <shell> [shell-args...]

            Required:
              --session <id>    Unique session identifier

            Options:
              --shell <type>    Shell type (pwsh, cmd, bash, zsh)
              --cwd <path>      Working directory
              --cols <n>        Terminal columns (default: 80)
              --rows <n>        Terminal rows (default: 24)
              --loglevel <lvl>  Log level: exception, error, warn, info, verbose (default: warn)
              --debug           Shortcut for --loglevel verbose
              -h, --help        Show this help
              -v, --version     Show version

            PTY Exec Mode (Unix only):
              --pty-exec        Set up PTY and exec shell (internal, does not return)

            IPC (Windows):
              Listens on named pipe: mthost-<session-id>-<pid>
            IPC (macOS/Linux):
              Listens on Unix socket: /tmp/mthost-<session-id>-<pid>.sock
            """);
    }

#if !WINDOWS
    private static void OnSignal(PosixSignalContext context)
    {
        Log.Info(() => $"Received signal {context.Signal}, initiating graceful shutdown");
        context.Cancel = true;
        _shutdownCts?.Cancel();
    }
#endif

    private sealed record SessionConfig(string SessionId, string? ShellType, string WorkingDirectory, int Cols, int Rows, LogSeverity LogSeverity);
}

internal sealed class TerminalSession
{
    private const int BufferCapacity = 10 * 1024 * 1024; // 10MB fixed buffer

    private readonly IPtyConnection _pty;
    private readonly IProcessMonitor? _processMonitor;
    private readonly CircularByteBuffer _outputBuffer = new(BufferCapacity);
    private readonly object _bufferLock = new();

    public string Id { get; }
    public ShellType ShellType { get; }
    public int Cols { get; private set; }
    public int Rows { get; private set; }
    public string? Name { get; private set; }
    public DateTime CreatedAt { get; } = DateTime.UtcNow;

    public int Pid => _pty.Pid;
    public bool IsRunning => _pty.IsRunning;
    public int? ExitCode => _pty.ExitCode;

    public event Action<ReadOnlyMemory<byte>>? OnOutput;
    public event Action? OnStateChanged;
    public event Action<ProcessEvent>? OnProcessEvent;
    public event Action<ForegroundProcessInfo>? OnForegroundChanged;

    public TerminalSession(string id, IPtyConnection pty, ShellType shellType, int cols, int rows, IProcessMonitor? processMonitor = null)
    {
        Id = id;
        _pty = pty;
        _processMonitor = processMonitor;
        ShellType = shellType;
        Cols = cols;
        Rows = rows;

        if (_processMonitor is not null)
        {
            _processMonitor.OnProcessEvent += evt => OnProcessEvent?.Invoke(evt);
            _processMonitor.OnForegroundChanged += info => OnForegroundChanged?.Invoke(info);
        }
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
                catch (IOException ex)
                {
                    Log.Exception(ex, "TerminalSession.ReadLoop");
                    break;
                }

                if (bytesRead == 0)
                {
                    break;
                }

                var data = buffer.AsMemory(0, bytesRead);
                if (bytesRead < 50)
                {
                    Log.Verbose(() => $"[PTY-READ] {BitConverter.ToString(data.ToArray())}");
                }

                lock (_bufferLock)
                {
                    _outputBuffer.Write(data.Span);
                }

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
            Log.Verbose(() => $"[PTY-WRITE] {BitConverter.ToString(data)}");
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
            return _outputBuffer.ToArray();
        }
    }

    public SessionInfo GetInfo()
    {
        var info = new SessionInfo
        {
            Id = Id,
            Pid = Pid,
            HostPid = Environment.ProcessId,
            ShellType = ShellType.ToString(),
            Cols = Cols,
            Rows = Rows,
            IsRunning = IsRunning,
            ExitCode = ExitCode,
            Name = Name,
            CreatedAt = CreatedAt,
            TtyHostVersion = VersionInfo.Version
        };

        if (_processMonitor is not null)
        {
            info.CurrentDirectory = _processMonitor.GetProcessCwd(Pid);
            var foregroundPid = _processMonitor.GetForegroundProcess(Pid);
            if (foregroundPid != Pid)
            {
                info.ForegroundPid = foregroundPid;
                info.ForegroundName = _processMonitor.GetProcessName(foregroundPid);
                info.ForegroundCommandLine = _processMonitor.GetProcessCommandLine(foregroundPid);
            }
        }

        return info;
    }

    public ProcessTreeSnapshot? GetProcessSnapshot()
    {
        return _processMonitor?.GetProcessTreeSnapshot(Pid);
    }

    public void Kill()
    {
        _pty.Kill();
    }
}
