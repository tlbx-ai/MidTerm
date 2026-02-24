using System.Text.RegularExpressions;
using Ai.Tlbx.MidTerm.Services.Security;

namespace Ai.Tlbx.MidTerm.Services;

public static partial class UserValidationService
{
    private const int MaxUsernameLength = 32;

    [GeneratedRegex(@"^[a-zA-Z_][a-zA-Z0-9._-]*$")]
    private static partial Regex UnixUsernamePattern();

    [GeneratedRegex(@"^S-1-[0-9]+-(\d+-)*\d+$")]
    private static partial Regex WindowsSidPattern();

    public static bool IsValidUsernameFormat(string? username)
    {
        if (string.IsNullOrWhiteSpace(username))
        {
            return true;
        }

        if (username.Length > MaxUsernameLength)
        {
            return false;
        }

        return UnixUsernamePattern().IsMatch(username);
    }

    public static bool IsSystemUser(string? username)
    {
        if (string.IsNullOrWhiteSpace(username))
        {
            return true;
        }

        var users = SystemUserProvider.GetSystemUsers();
        return users.Any(u => string.Equals(u.Username, username, StringComparison.Ordinal));
    }

    public static bool IsValidWindowsSid(string? sid)
    {
        if (string.IsNullOrWhiteSpace(sid))
        {
            return true;
        }

        return WindowsSidPattern().IsMatch(sid);
    }

    public static (bool IsValid, string? Error) ValidateRunAsUser(string? username)
    {
        if (string.IsNullOrWhiteSpace(username))
        {
            return (true, null);
        }

        if (!IsValidUsernameFormat(username))
        {
            return (false, $"Invalid username format: {username}");
        }

        if (!OperatingSystem.IsWindows() && !IsSystemUser(username))
        {
            return (false, $"User does not exist on system: {username}");
        }

        return (true, null);
    }
}
