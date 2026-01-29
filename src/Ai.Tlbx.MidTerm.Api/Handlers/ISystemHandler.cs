using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Http;

namespace Ai.Tlbx.MidTerm.Api.Handlers;

public interface ISystemHandler
{
    IResult GetBootstrap();
    IResult GetBootstrapLogin();
    IResult GetSystem();
    IResult GetVersion();
    IResult GetHealth();
    IResult GetVersionDetails();
    IResult GetCertificateInfo();
    IResult DownloadCertificatePem();
    IResult DownloadMobileConfig(HttpContext context);
    IResult GetSharePacket(HttpContext context);
    IResult GetNetworks();
    IResult GetShells();
    IResult GetUsers();
    IResult GetSettings();
    IResult UpdateSettings(MidTermSettingsPublic settings);
    IResult ReloadSettings();
    IResult GetPaths();
    Task<IResult> CheckUpdateAsync();
    Task<IResult> ApplyUpdateAsync(string? source);
    IResult GetUpdateResult(bool clear);
    IResult DeleteUpdateResult();
    IResult GetUpdateLog();
}
