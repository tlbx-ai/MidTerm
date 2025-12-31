using Ai.Tlbx.MiddleManager.Host.Ipc;
using Ai.Tlbx.MiddleManager.Host.Services;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Ai.Tlbx.MiddleManager.Host;

public static class Log
{
    private static readonly string LogDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "MiddleManager",
        "logs");

    private static readonly string LogPath = Path.Combine(LogDir, "mm-host.log");
    private static readonly object Lock = new();

    public static void Write(string message)
    {
        var line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}] {message}";
        Console.WriteLine(line);
        try
        {
            lock (Lock)
            {
                Directory.CreateDirectory(LogDir);
                File.AppendAllText(LogPath, line + Environment.NewLine);
            }
        }
        catch { }
    }
}

public static class Program
{
    public const string Version = "2.5.2";

    public static async Task<int> Main(string[] args)
    {
        if (args.Contains("--version") || args.Contains("-v"))
        {
            Console.WriteLine($"mm-host {Version}");
            return 0;
        }

        if (args.Contains("--help") || args.Contains("-h"))
        {
            PrintHelp();
            return 0;
        }

        var isServiceMode = args.Contains("--service");
        var (port, bindAddress) = ParseArgs(args);

        Log.Write($"mm-host {Version} starting{(isServiceMode ? " (service mode)" : "")}...");

        try
        {
            var builder = Microsoft.Extensions.Hosting.Host.CreateApplicationBuilder(args);

#if WINDOWS
            builder.Services.AddWindowsService(options =>
            {
                options.ServiceName = "MiddleManager";
            });
#else
            builder.Services.AddSystemd();
#endif

            builder.Services.AddSingleton<SessionManager>();
            builder.Services.AddSingleton(new SupervisorConfig(isServiceMode, port, bindAddress));
            builder.Services.AddHostedService<SidecarHostedService>();

            var host = builder.Build();
            await host.RunAsync();
            return 0;
        }
        catch (Exception ex)
        {
            Log.Write($"Fatal error: {ex.Message}");
            return 1;
        }
    }

    private static (int port, string bindAddress) ParseArgs(string[] args)
    {
        var port = 2000;
        var bindAddress = "0.0.0.0";

        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--port" && i + 1 < args.Length && int.TryParse(args[i + 1], out var p))
            {
                port = p;
                i++;
            }
            else if (args[i] == "--bind" && i + 1 < args.Length)
            {
                bindAddress = args[i + 1];
                i++;
            }
        }

        return (port, bindAddress);
    }

    private static void PrintHelp()
    {
        Console.WriteLine($"""
            mm-host {Version} - MiddleManager Terminal Host

            Usage: mm-host [options]

            Options:
              -h, --help       Show this help message
              -v, --version    Show version information
              --service        Service mode: spawn and supervise mm.exe
              --port <port>    Port for mm.exe web server (default: 2000)
              --bind <addr>    Bind address for mm.exe (default: 0.0.0.0)

            Environment Variables:
              MM_RUN_AS_USER       Username to run terminals as
              MM_RUN_AS_USER_SID   Windows SID for user de-elevation
              MM_RUN_AS_UID        Unix UID for user de-elevation
              MM_RUN_AS_GID        Unix GID for user de-elevation

            IPC Endpoint:
              {IpcServerFactory.GetEndpointDescription()}

            In standalone mode (default), mm-host runs the IPC server only.
            In service mode (--service), mm-host also spawns and monitors mm.exe,
            restarting it automatically if it crashes.
            """);
    }
}

public sealed record SupervisorConfig(bool IsServiceMode, int Port, string BindAddress);

public sealed class SidecarHostedService : BackgroundService
{
    private readonly SessionManager _sessionManager;
    private readonly SupervisorConfig _config;
    private SidecarServer? _server;
    private WebServerSupervisor? _supervisor;

    public SidecarHostedService(SessionManager sessionManager, SupervisorConfig config)
    {
        _sessionManager = sessionManager;
        _config = config;

        _sessionManager.RunAsUser = Environment.GetEnvironmentVariable("MM_RUN_AS_USER");
        _sessionManager.RunAsUserSid = Environment.GetEnvironmentVariable("MM_RUN_AS_USER_SID");
        if (int.TryParse(Environment.GetEnvironmentVariable("MM_RUN_AS_UID"), out var uid))
        {
            _sessionManager.RunAsUid = uid;
        }
        if (int.TryParse(Environment.GetEnvironmentVariable("MM_RUN_AS_GID"), out var gid))
        {
            _sessionManager.RunAsGid = gid;
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _server = new SidecarServer(_sessionManager);
        await _server.StartAsync(stoppingToken);

        if (_config.IsServiceMode)
        {
            _supervisor = new WebServerSupervisor(_config.Port, _config.BindAddress);
            await _supervisor.RunAsync(stoppingToken);
        }
        else
        {
            try
            {
                await Task.Delay(Timeout.Infinite, stoppingToken);
            }
            catch (OperationCanceledException)
            {
            }
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        Log.Write("Shutting down...");

        if (_supervisor is not null)
        {
            await _supervisor.DisposeAsync();
        }

        if (_server is not null)
        {
            await _server.DisposeAsync();
        }

        _sessionManager.Dispose();
        await base.StopAsync(cancellationToken);
    }
}
