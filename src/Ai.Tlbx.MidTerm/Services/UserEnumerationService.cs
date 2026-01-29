using System.Runtime.InteropServices;
using Ai.Tlbx.MidTerm.Models;

namespace Ai.Tlbx.MidTerm.Services;

public static class UserEnumerationService
{
    public static List<UserInfo> GetSystemUsers()
    {
        if (OperatingSystem.IsWindows())
        {
            return GetWindowsUsers();
        }
        else
        {
            return GetUnixUsers();
        }
    }

    private static List<UserInfo> GetWindowsUsers()
    {
        var users = new List<UserInfo>();

        if (!OperatingSystem.IsWindows())
        {
            return users;
        }

        try
        {
            // Use WMI via PowerShell to get local users
            // This avoids complex P/Invoke for NetUserEnum
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "powershell",
                Arguments = "-NoProfile -Command \"Get-LocalUser | Where-Object { $_.Enabled -eq $true } | Select-Object Name, SID | ConvertTo-Json\"",
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            using var process = System.Diagnostics.Process.Start(psi);
            if (process is null)
            {
                return users;
            }

            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit();

            if (string.IsNullOrWhiteSpace(output))
            {
                return users;
            }

            // Parse JSON output
            using var doc = System.Text.Json.JsonDocument.Parse(output);
            var root = doc.RootElement;

            // Handle single user (not array) vs multiple users (array)
            if (root.ValueKind == System.Text.Json.JsonValueKind.Array)
            {
                foreach (var user in root.EnumerateArray())
                {
                    var name = user.GetProperty("Name").GetString();
                    var sidObj = user.GetProperty("SID");
                    var sid = sidObj.ValueKind == System.Text.Json.JsonValueKind.Object
                        ? sidObj.GetProperty("Value").GetString()
                        : sidObj.GetString();

                    if (!string.IsNullOrEmpty(name))
                    {
                        users.Add(new UserInfo
                        {
                            Username = name,
                            Sid = sid
                        });
                    }
                }
            }
            else if (root.ValueKind == System.Text.Json.JsonValueKind.Object)
            {
                var name = root.GetProperty("Name").GetString();
                var sidObj = root.GetProperty("SID");
                var sid = sidObj.ValueKind == System.Text.Json.JsonValueKind.Object
                    ? sidObj.GetProperty("Value").GetString()
                    : sidObj.GetString();

                if (!string.IsNullOrEmpty(name))
                {
                    users.Add(new UserInfo
                    {
                        Username = name,
                        Sid = sid
                    });
                }
            }
        }
        catch
        {
            // Fall back to current user only
            try
            {
                var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
                var userName = identity.Name.Split('\\').Last();
                users.Add(new UserInfo
                {
                    Username = userName,
                    Sid = identity.User?.Value
                });
            }
            catch
            {
            }
        }

        return users;
    }

    private static List<UserInfo> GetUnixUsers()
    {
        var users = new List<UserInfo>();

        try
        {
            // Read /etc/passwd and filter for regular users
            var passwdPath = "/etc/passwd";
            if (!File.Exists(passwdPath))
            {
                return users;
            }

            var lines = File.ReadAllLines(passwdPath);
            foreach (var line in lines)
            {
                var parts = line.Split(':');
                if (parts.Length < 7)
                {
                    continue;
                }

                var username = parts[0];
                var uidStr = parts[2];
                var gidStr = parts[3];
                var shell = parts[6];

                if (!int.TryParse(uidStr, out var uid) || !int.TryParse(gidStr, out var gid))
                {
                    continue;
                }

                // Filter: UID >= 500 (macOS) or >= 1000 (Linux) for regular users
                // Also filter out nologin shells
                var minUid = OperatingSystem.IsMacOS() ? 500 : 1000;
                if (uid < minUid)
                {
                    continue;
                }

                if (shell.Contains("nologin") || shell.Contains("false"))
                {
                    continue;
                }

                // Skip special users
                if (username == "nobody" || username == "daemon" || username.StartsWith("_"))
                {
                    continue;
                }

                users.Add(new UserInfo
                {
                    Username = username,
                    Uid = uid,
                    Gid = gid
                });
            }
        }
        catch
        {
            // Fall back to current user
            try
            {
                var username = Environment.UserName;
                users.Add(new UserInfo
                {
                    Username = username,
                    Uid = (int)getuid(),
                    Gid = (int)getgid()
                });
            }
            catch
            {
            }
        }

        return users;
    }

    [DllImport("libc", EntryPoint = "getuid")]
    private static extern uint getuid();

    [DllImport("libc", EntryPoint = "getgid")]
    private static extern uint getgid();
}
