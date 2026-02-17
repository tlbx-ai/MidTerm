namespace Ai.Tlbx.MidTerm.TtyHost.Pty;

/// <summary>
/// Cross-platform pseudo-terminal connection interface.
/// Implemented by WindowsPty (ConPTY) and UnixPty (forkpty).
/// </summary>
public interface IPtyConnection : IDisposable
{
    /// <summary>Stream for writing input to the PTY.</summary>
    Stream WriterStream { get; }
    /// <summary>Stream for reading output from the PTY.</summary>
    Stream ReaderStream { get; }
    /// <summary>Process ID of the shell process.</summary>
    int Pid { get; }
    /// <summary>PTY master file descriptor (Unix only, -1 on Windows).</summary>
    int MasterFd { get; }
    /// <summary>Whether the shell process is still running.</summary>
    bool IsRunning { get; }
    /// <summary>Exit code of the shell process, or null if still running.</summary>
    int? ExitCode { get; }
    /// <summary>Resizes the PTY to the specified dimensions.</summary>
    void Resize(int cols, int rows);
    /// <summary>Forcibly terminates the shell process.</summary>
    void Kill();
    /// <summary>Waits for the shell process to exit within the specified timeout.</summary>
    bool WaitForExit(int milliseconds);
}
