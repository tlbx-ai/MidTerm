namespace Ai.Tlbx.MidTerm.Services.Hosting;

public sealed class ServerBindingInfo
{
    public ServerBindingInfo(int port, string bindAddress)
    {
        Port = port;
        BindAddress = bindAddress;
    }

    public int Port { get; }
    public string BindAddress { get; }
}
