using Ai.Tlbx.MidTerm.Api.Handlers;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Http;

namespace Ai.Tlbx.MidTerm.OpenApi.Stubs;

public class StubHistoryHandler : IHistoryHandler
{
    public IResult GetHistory() =>
        Results.Json(new List<LaunchEntry>());

    public IResult CreateHistoryEntry(CreateHistoryRequest request) =>
        Results.Ok(new { id = "stub" });

    public IResult PatchHistoryEntry(string id, HistoryPatchRequest request) =>
        Results.Ok();

    public IResult ToggleStar(string id) =>
        Results.Ok();

    public IResult DeleteHistoryEntry(string id) =>
        Results.Ok();
}
