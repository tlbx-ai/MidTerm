using System.Runtime.Versioning;
using Ai.Tlbx.MidTerm.Services;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class UserValidationServiceTests
{
    [Theory]
    [InlineData(@"ATURIS\Johannes Schmidt")]
    [InlineData("johannes.schmidt@aturis.local")]
    [InlineData("adm.js")]
    [SupportedOSPlatform("windows")]
    public void IsValidWindowsUsernameFormat_AllowsWindowsAccountForms(string accountName)
    {
        Assert.True(UserValidationService.IsValidWindowsUsernameFormat(accountName));
    }
}
