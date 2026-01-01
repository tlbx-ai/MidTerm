using Ai.Tlbx.MiddleManager.Shells;

namespace Ai.Tlbx.MiddleManager.Settings
{
    public sealed class MiddleManagerSettings
    {
        // Session Defaults
        public ShellType DefaultShell { get; set; } = GetPlatformDefaultShell();
        public int DefaultCols { get; set; } = 120;
        public int DefaultRows { get; set; } = 30;
        public string DefaultWorkingDirectory { get; set; } = "";

        private static ShellType GetPlatformDefaultShell()
        {
            if (OperatingSystem.IsWindows())
            {
                return ShellType.Pwsh;
            }
            if (OperatingSystem.IsMacOS())
            {
                return ShellType.Zsh;
            }
            return ShellType.Bash;
        }

        // Terminal Appearance
        public int FontSize { get; set; } = 14;
        public string CursorStyle { get; set; } = "bar";
        public bool CursorBlink { get; set; } = true;
        public string Theme { get; set; } = "dark";

        // Terminal Behavior
        public int ScrollbackLines { get; set; } = 10000;
        public string BellStyle { get; set; } = "notification";
        public bool CopyOnSelect { get; set; } = false;
        public bool RightClickPaste { get; set; } = true;
        public string ClipboardShortcuts { get; set; } = "auto";

        // Security - User to spawn terminals as (when running as service)
        public string? RunAsUser { get; set; }
        public string? RunAsUserSid { get; set; }  // Windows: User SID for token lookup
        public int? RunAsUid { get; set; }         // Unix: User ID
        public int? RunAsGid { get; set; }         // Unix: Group ID

        // Authentication
        public bool AuthenticationEnabled { get; set; } = false;
        public string? PasswordHash { get; set; }
        public string? SessionSecret { get; set; }

        // Diagnostics
        public bool DebugLogging { get; set; } = false;
    }
}
