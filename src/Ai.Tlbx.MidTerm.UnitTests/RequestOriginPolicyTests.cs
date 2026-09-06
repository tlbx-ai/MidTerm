using Ai.Tlbx.MidTerm.Startup;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class RequestOriginPolicyTests
{
    [Theory]
    [InlineData("https://tlbx.test:2000", true)]
    [InlineData("https://tlbx.test:2001", false)]
    [InlineData("https://tlbx.test.attacker.invalid:2000", false)]
    [InlineData("https://attacker.invalid:2000", false)]
    [InlineData("http://tlbx.test:2000", false)]
    [InlineData("null", false)]
    [InlineData("https://tlbx.test:2000/path", false)]
    public void CookieBearingMutationsAndSockets_RequireExactOrigin(string origin, bool allowed)
    {
        foreach (var (method, path) in new[] { ("POST", "/api/auth/login"), ("POST", "/api/sessions"), ("GET", "/ws/mux") })
        {
            var context = new DefaultHttpContext();
            context.Request.Scheme = "https";
            context.Request.Host = new HostString("tlbx.test", 2000);
            context.Request.Method = method;
            context.Request.Path = path;
            context.Request.Headers.Origin = origin;
            Assert.Equal(allowed, RequestOriginPolicy.Allows(context.Request));
        }
    }

    [Fact]
    public void MissingOrigin_AllowsNativeClientsButNotCrossSiteBrowserRequests()
    {
        var context = new DefaultHttpContext();
        context.Request.Method = "POST";
        context.Request.Path = "/api/sessions";
        Assert.True(RequestOriginPolicy.Allows(context.Request));
        context.Request.Headers["Sec-Fetch-Site"] = "cross-site";
        Assert.False(RequestOriginPolicy.Allows(context.Request));
    }
}
