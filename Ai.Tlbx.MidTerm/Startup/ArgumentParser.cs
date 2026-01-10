namespace Ai.Tlbx.MidTerm.Startup;

public static class ArgumentParser
{
    public const int DefaultPort = 2000;
    public const string DefaultBindAddress = "0.0.0.0";

    public static (int port, string bindAddress) Parse(string[] args)
    {
        var port = DefaultPort;
        var bindAddress = DefaultBindAddress;

        for (int i = 0; i < args.Length; i++)
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
}
