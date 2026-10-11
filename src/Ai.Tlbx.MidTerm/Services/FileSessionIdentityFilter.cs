using Ai.Tlbx.MidTerm.Models.Files;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>Filesystem readers and saves use the terminal account, including deferred file responses.</summary>
internal sealed class FileSessionIdentityFilter(FileService files, SettingsService settings) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        if (!OperatingSystem.IsWindows() || !settings.IsRunningAsService) return await next(context);
        var sessionId = context.HttpContext.Request.Query["sessionId"].FirstOrDefault()
            ?? context.Arguments.OfType<FileRegisterRequest>().FirstOrDefault()?.SessionId;
        if (string.IsNullOrEmpty(sessionId)) return FileEndpoints.DocumentError(
            new FileDocumentException(400, "session_required", "Select a session before accessing files."), sessionId, files);
        try
        {
            var host = files.GetSessionHostIdentity(sessionId) ?? throw new FileDocumentException(404, "session_closed", "The session host is no longer available.");
            var result = await SessionCallerIdentity.RunForSessionAsync(host.Pid, host.Started, () => next(context).AsTask());
            return result is IResult response ? new IdentityResult(response, host.Pid, host.Started, files, sessionId) : result;
        }
        catch (Exception ex) when (ex is SessionCallerIdentityException or FileDocumentException or System.ComponentModel.Win32Exception)
        { return FileEndpoints.DocumentError(ex, sessionId, files); }
    }

    private sealed class IdentityResult(IResult response, int pid, DateTime started, FileService files, string sessionId) : IResult
    {
        public async Task ExecuteAsync(HttpContext context)
        {
            try
            {
                await SessionCallerIdentity.RunForSessionAsync(pid, started, async () => { await response.ExecuteAsync(context); return true; });
            }
            catch (SessionCallerIdentityException error)
            {
                if (context.Response.HasStarted) context.Abort();
                else await FileEndpoints.DocumentError(error, sessionId, files).ExecuteAsync(context);
            }
        }
    }
}
