using Ai.Tlbx.MidTerm.Common.Ipc;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class IpcEndpointTests
{
    [Fact]
    public void ParseEndpoint_NewFormat_RoundTripsInstanceAndSession()
    {
        var endpoint = IpcEndpoint.BuildEndpointName("inst1234abcd5678", "sess0001", 4242);

        var parsed = IpcEndpoint.ParseEndpoint(endpoint);

        Assert.NotNull(parsed);
        Assert.Equal("inst1234abcd5678", parsed!.Value.instanceId);
        Assert.Equal("sess0001", parsed.Value.sessionId);
        Assert.Equal(4242, parsed.Value.pid);
    }

    [Fact]
    public void ParseEndpoint_LegacyFormat_PreservesOwnerlessShape()
    {
        var parsed = IpcEndpoint.ParseEndpoint("mthost-sess0001-4242");

        Assert.NotNull(parsed);
        Assert.Null(parsed!.Value.instanceId);
        Assert.Equal("sess0001", parsed.Value.sessionId);
        Assert.Equal(4242, parsed.Value.pid);
    }
}
