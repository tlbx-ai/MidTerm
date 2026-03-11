using Ai.Tlbx.MidTerm.Models.System;
using Ai.Tlbx.MidTerm.Services.Share;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class ShareUrlBuilderTests
{
    [Fact]
    public void ResolveShareHost_PreservesRoutableRequestHost()
    {
        var interfaces = new[]
        {
            new NetworkInterfaceDto { Name = "Ethernet", Ip = "192.168.1.50" }
        };

        var host = ShareUrlBuilder.ResolveShareHost("midterm-box", interfaces);

        Assert.Equal("midterm-box", host);
    }

    [Fact]
    public void ResolveShareHost_ReplacesLoopbackWithPrivateLanAddress()
    {
        var interfaces = new[]
        {
            new NetworkInterfaceDto { Name = "Localhost", Ip = "localhost" },
            new NetworkInterfaceDto { Name = "Tailscale", Ip = "100.64.0.10" },
            new NetworkInterfaceDto { Name = "Wi-Fi", Ip = "192.168.1.50" },
            new NetworkInterfaceDto { Name = "APIPA", Ip = "169.254.10.20" }
        };

        var host = ShareUrlBuilder.ResolveShareHost("localhost", interfaces);

        Assert.Equal("192.168.1.50", host);
    }

    [Fact]
    public void BuildShareUrl_UsesResolvedHostAndPreservesPortAndFragment()
    {
        var context = new DefaultHttpContext();
        context.Request.Scheme = "https";
        context.Request.Host = new HostString("localhost", 2000);

        var url = ShareUrlBuilder.BuildShareUrl(
            context.Request,
            [new NetworkInterfaceDto { Name = "Ethernet", Ip = "192.168.1.50" }],
            "grant-1",
            "secret-1");

        Assert.Equal("https://192.168.1.50:2000/shared/grant-1#secret-1", url);
    }

    [Fact]
    public void BuildShareUrl_UsesExplicitSelectedHost_WhenAllowed()
    {
        var context = new DefaultHttpContext();
        context.Request.Scheme = "https";
        context.Request.Host = new HostString("localhost", 2000);

        var url = ShareUrlBuilder.BuildShareUrl(
            context.Request,
            [new NetworkInterfaceDto { Name = "Localhost", Ip = "localhost" }],
            "grant-1",
            "secret-1",
            preferredHost: "localhost");

        Assert.Equal("https://localhost:2000/shared/grant-1#secret-1", url);
    }

    [Fact]
    public void ResolveShareHost_IgnoresUnknownExplicitHost_AndFallsBack()
    {
        var interfaces = new[]
        {
            new NetworkInterfaceDto { Name = "Wi-Fi", Ip = "192.168.1.50" }
        };

        var host = ShareUrlBuilder.ResolveShareHost(
            "localhost",
            interfaces,
            preferredHost: "example.invalid");

        Assert.Equal("192.168.1.50", host);
    }
}
