using System.Reflection;

namespace Ai.Tlbx.MidTerm.AgentHost;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        if (args.Contains("--help", StringComparer.Ordinal) || args.Contains("-h", StringComparer.Ordinal))
        {
            PrintHelp();
            return 0;
        }

        if (args.Contains("--version", StringComparer.Ordinal) || args.Contains("-v", StringComparer.Ordinal))
        {
            Console.WriteLine(GetVersion());
            return 0;
        }

        if (!args.Contains("--stdio", StringComparer.Ordinal))
        {
            Console.Error.WriteLine("mtagenthost requires --stdio.");
            return 1;
        }

        var syntheticProvider = ReadOption(args, "--synthetic");
        await using var server = new LensAgentHostServer(syntheticProvider);
        await server.RunAsync().ConfigureAwait(false);
        return 0;
    }

    private static string? ReadOption(IReadOnlyList<string> args, string name)
    {
        for (var i = 0; i < args.Count - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.Ordinal))
            {
                return args[i + 1];
            }
        }

        return null;
    }

    private static void PrintHelp()
    {
        Console.WriteLine(
            """
            mtagenthost - MidTerm external agent runtime host

            Usage:
              mtagenthost --stdio
              mtagenthost --stdio --synthetic <provider>
              mtagenthost --version
              mtagenthost --help

            Current scope:
              - stdio JSON transport
              - real Codex app-server runtime
              - synthetic provider mode for protocol/integration testing
            """);
    }

    private static string GetVersion()
    {
        var version = typeof(Program).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion;
        if (string.IsNullOrWhiteSpace(version))
        {
            version = typeof(Program).Assembly.GetName().Version?.ToString();
        }

        return $"mtagenthost {version ?? "0.0.0"}";
    }
}
