using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Http;

using Ai.Tlbx.MidTerm.Models.Auth;
using Ai.Tlbx.MidTerm.Models.Certificates;
using Ai.Tlbx.MidTerm.Models.Files;
using Ai.Tlbx.MidTerm.Models.History;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Models.System;
namespace Ai.Tlbx.MidTerm.Api.Handlers;

public interface IHistoryHandler
{
    IResult GetHistory();
    IResult CreateHistoryEntry(CreateHistoryRequest request);
    IResult PatchHistoryEntry(string id, HistoryPatchRequest request);
    IResult ToggleStar(string id);
    IResult DeleteHistoryEntry(string id);
    IResult ReorderHistory(HistoryReorderRequest request);
}
