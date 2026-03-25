using Ai.Tlbx.MidTerm.Models.System;
using Ai.Tlbx.MidTerm.Services.Security;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class SystemUserProviderTests
{
    [Theory]
    [InlineData(@"ATURIS\johannes.schmidt", "johannes.schmidt")]
    [InlineData("johannes.schmidt@aturis.local", "johannes.schmidt")]
    [InlineData("johannes.schmidt", "johannes.schmidt")]
    public void NormalizeWindowsUsername_StripsDomainPrefixes(string raw, string expected)
    {
        Assert.Equal(expected, SystemUserProvider.NormalizeWindowsUsername(raw));
    }

    [Fact]
    public void AddWindowsUser_DeduplicatesNamesAndPreservesSid()
    {
        var users = new Dictionary<string, UserInfo>(StringComparer.OrdinalIgnoreCase);

        SystemUserProvider.AddWindowsUser(users, @"ATURIS\johannes.schmidt");
        SystemUserProvider.AddWindowsUser(users, "johannes.schmidt", "S-1-5-21-123");

        var entry = Assert.Single(users);
        Assert.Equal("johannes.schmidt", entry.Value.Username);
        Assert.Equal("S-1-5-21-123", entry.Value.Sid);
    }
}
