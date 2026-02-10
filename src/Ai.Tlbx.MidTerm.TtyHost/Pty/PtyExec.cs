#if !WINDOWS
using System.Runtime.InteropServices;

namespace Ai.Tlbx.MidTerm.TtyHost.Pty;

/// <summary>
/// PTY exec helper for Unix systems. Called via mthost --pty-exec.
/// Sets up controlling terminal and replaces process with shell.
/// </summary>
internal static class PtyExec
{
    private const int O_RDWR = 2;

    private static readonly nuint TIOCSWINSZ = OperatingSystem.IsMacOS()
        ? 0x80087467
        : 0x5414;

    [StructLayout(LayoutKind.Sequential)]
    private struct WinSize
    {
        public ushort ws_row;
        public ushort ws_col;
        public ushort ws_xpixel;
        public ushort ws_ypixel;
    }

    [DllImport("libc", SetLastError = true, CallingConvention = CallingConvention.Cdecl)]
    private static extern int setsid();

    [DllImport("libc", SetLastError = true, CallingConvention = CallingConvention.Cdecl)]
    private static extern int open([MarshalAs(UnmanagedType.LPStr)] string path, int flags);

    [DllImport("libc", SetLastError = true, CallingConvention = CallingConvention.Cdecl)]
    private static extern int dup2(int oldfd, int newfd);

    [DllImport("libc", SetLastError = true, CallingConvention = CallingConvention.Cdecl)]
    private static extern int close(int fd);

    [DllImport("libc", SetLastError = true, CallingConvention = CallingConvention.Cdecl)]
    private static extern int ioctl(int fd, nuint request, ref WinSize winsize);

    [DllImport("libc", SetLastError = true, CallingConvention = CallingConvention.Cdecl)]
    private static extern int execvp(
        [MarshalAs(UnmanagedType.LPStr)] string file,
        [MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.LPStr)] string?[] argv);

    /// <summary>
    /// PTY exec mode: setsid, open slave, set window size, dup2, execvp.
    /// NEVER returns on success - execvp replaces the process.
    /// </summary>
    /// <returns>
    /// Exit code on failure:
    /// 1 = setsid failed, 2 = open failed, 3 = dup2 failed, 4 = execvp failed, 5 = invalid args
    /// </returns>
    public static int Execute(string slavePath, int cols, int rows, string[] execArgs)
    {
        if (string.IsNullOrEmpty(slavePath) || execArgs is null || execArgs.Length == 0)
        {
            return 5;
        }

        if (setsid() < 0)
        {
            return 1;
        }

        int fd = open(slavePath, O_RDWR);
        if (fd < 0)
        {
            return 2;
        }

        // Set window size on slave fd (master fd ioctl fails with ENOTTY on macOS)
        if (cols > 0 && rows > 0)
        {
            var winSize = new WinSize
            {
                ws_col = (ushort)Math.Clamp(cols, 1, 500),
                ws_row = (ushort)Math.Clamp(rows, 1, 500)
            };
            ioctl(fd, TIOCSWINSZ, ref winSize);
        }

        if (dup2(fd, 0) < 0 || dup2(fd, 1) < 0 || dup2(fd, 2) < 0)
        {
            close(fd);
            return 3;
        }

        if (fd > 2)
        {
            close(fd);
        }

        var argv = new string?[execArgs.Length + 1];
        Array.Copy(execArgs, argv, execArgs.Length);
        argv[execArgs.Length] = null;

        execvp(execArgs[0], argv);

        return 4;
    }
}
#endif
