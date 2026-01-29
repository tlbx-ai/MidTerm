using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Http;

namespace Ai.Tlbx.MidTerm.Api.Handlers;

public interface IHistoryHandler
{
    IResult GetHistory();
    IResult CreateHistoryEntry(CreateHistoryRequest request);
    IResult PatchHistoryEntry(string id, HistoryPatchRequest request);
    IResult ToggleStar(string id);
    IResult DeleteHistoryEntry(string id);
}
