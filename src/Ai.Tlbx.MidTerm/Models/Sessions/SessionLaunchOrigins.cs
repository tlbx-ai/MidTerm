namespace Ai.Tlbx.MidTerm.Models.Sessions;

public static class SessionLaunchOrigins
{
    public const string AdHoc = "adhoc";
    public const string Space = "space";

    public static string? Normalize(string? origin)
    {
        return origin?.Trim().ToLowerInvariant() switch
        {
            AdHoc => AdHoc,
            "ad-hoc" => AdHoc,
            Space => Space,
            _ => null
        };
    }
}
