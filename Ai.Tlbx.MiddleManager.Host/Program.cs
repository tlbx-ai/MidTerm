using Ai.Tlbx.MiddleManager.Host.Ipc;
using Ai.Tlbx.MiddleManager.Host.Services;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Ai.Tlbx.MiddleManager.Host;

public static class Program
{
    public const string Version = "2.0.2";

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

        Console.WriteLine($"mm-host {Version} starting...");

        try
        {
            var builder = Microsoft.Extensions.Hosting.Host.CreateApplicationBuilder(args);

#if WINDOWS
            builder.Services.AddWindowsService(options =>
            {
                options.ServiceName = "MiddleManagerHost";
            });
#else
            builder.Services.AddSystemd();
#endif

            builder.Services.AddSingleton<SessionManager>();
            builder.Services.AddHostedService<SidecarHostedService>();

            var host = builder.Build();
            await host.RunAsync();
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Fatal error: {ex.Message}");
            return 1;
        }
    }

    private static void PrintHelp()
    {
        Console.WriteLine($"""
            mm-host {Version} - MiddleManager Terminal Host

            Usage: mm-host [options]

            Options:
              -h, --help       Show this help message
              -v, --version    Show version information

            Environment Variables:
              MM_RUN_AS_USER       Username to run terminals as
              MM_RUN_AS_USER_SID   Windows SID for user de-elevation
              MM_RUN_AS_UID        Unix UID for user de-elevation
              MM_RUN_AS_GID        Unix GID for user de-elevation

            IPC Endpoint:
              {IpcServerFactory.GetEndpointDescription()}

            The host process manages terminal sessions and communicates with
            the mm web server via IPC. It keeps sessions alive across web
            server restarts.
            """);
    }
}

public sealed class SidecarHostedService : BackgroundService
{
    private readonly SessionManager _sessionManager;
    private SidecarServer? _server;

    public SidecarHostedService(SessionManager sessionManager)
    {
        _sessionManager = sessionManager;

        // Load runAs settings from environment (passed by web server or install script)
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

        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException)
        {
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        Console.WriteLine("Shutting down...");

        if (_server is not null)
        {
            await _server.DisposeAsync();
        }

        _sessionManager.Dispose();
        await base.StopAsync(cancellationToken);
    }
}
