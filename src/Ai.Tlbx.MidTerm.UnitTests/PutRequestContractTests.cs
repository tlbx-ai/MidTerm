using System.Text.Json;
using Ai.Tlbx.MidTerm.Services;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class PutRequestContractTests
{
    [Fact]
    public void FileSaveRequest_RejectsMissingContent()
    {
        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize("""{"path":"file.txt"}""", AppJsonContext.Default.FileSaveRequest));
    }

    [Fact]
    public void HubMachineRequest_RejectsMissingEnabledState()
    {
        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize(
                """{"name":"server","baseUrl":"https://server"}""",
                AppJsonContext.Default.HubMachineUpsertRequest));
    }

    [Fact]
    public void SessionControlRequest_RejectsMissingState()
    {
        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize("{}", AppJsonContext.Default.SetSessionControlRequest));
    }

    [Fact]
    public void SessionLayoutRequest_RejectsMissingNullableStateFields()
    {
        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize("""{"revision":1}""", AppJsonContext.Default.SessionLayoutState));
    }
}
