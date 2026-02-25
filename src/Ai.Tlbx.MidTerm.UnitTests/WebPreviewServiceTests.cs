using Ai.Tlbx.MidTerm.Services.WebPreview;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class WebPreviewServiceTests
{
    [Fact]
    public void SetTarget_PathWithTrailingSlash_PreservesTrailingSlash()
    {
        var service = new WebPreviewService(serverPort: 2000);

        var ok = service.SetTarget("https://example.com/coaching/plans/");

        Assert.True(ok);
        Assert.NotNull(service.TargetUri);
        Assert.Equal("/coaching/plans/", service.TargetUri!.AbsolutePath);
    }
}
