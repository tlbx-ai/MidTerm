#if LINUX
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Process;

namespace Ai.Tlbx.MidTerm.TtyHost.Process;

/// <summary>
/// Linux implementation of process monitoring using /proc filesystem.
/// Uses polling approach for compatibility (netlink requires CAP_NET_ADMIN).
/// </summary>
public sealed class LinuxProcessMonitor : IProcessMonitor
{
    private readonly object _lock = new();
    private readonly ConcurrentDictionary<int, ProcessInfo> _processTree = new();
    private int _rootPid;
    private bool _monitoring;
    private bool _disposed;
    private CancellationTokenSource? _pollCts;
    private Task? _pollTask;

    public event Action<ProcessEvent>? OnProcessEvent;
    public event Action<ForegroundProcessInfo>? OnForegroundChanged;

    public bool SupportsRealTimeEvents => false;

    public void StartMonitoring(int rootPid)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(LinuxProcessMonitor));

        lock (_lock)
        {
            _rootPid = rootPid;
            _monitoring = true;

            _pollCts = new CancellationTokenSource();
            _pollTask = Task.Run(() => PollProcessTreeAsync(_pollCts.Token));
        }
    }

    public void StopMonitoring()
    {
        lock (_lock)
        {
            _monitoring = false;
            _pollCts?.Cancel();
            try
            {
                _pollTask?.Wait(1000);
            }
            catch { }
            _pollCts?.Dispose();
            _pollCts = null;
            _pollTask = null;
        }
    }

    private async Task PollProcessTreeAsync(CancellationToken ct)
    {
        var previousPids = new HashSet<int>();
        int? previousForeground = null;

        while (!ct.IsCancellationRequested && _monitoring)
        {
            try
            {
                await Task.Delay(500, ct);

                var currentPids = new HashSet<int>();
                var descendants = GetDescendantProcesses(_rootPid);

                foreach (var pid in descendants)
                {
                    currentPids.Add(pid);

                    if (!previousPids.Contains(pid))
                    {
                        var name = GetProcessName(pid);
                        var cmdLine = GetProcessCommandLine(pid);
                        var parentPid = GetParentPid(pid);

                        var info = new ProcessInfo
                        {
                            Pid = pid,
                            ParentPid = parentPid,
                            Name = name ?? "unknown",
                            CommandLine = cmdLine,
                            Cwd = GetProcessCwd(pid)
                        };
                        _processTree[pid] = info;

                        OnProcessEvent?.Invoke(new ProcessEvent
                        {
                            Type = ProcessEventType.Exec,
                            Pid = pid,
                            ParentPid = parentPid,
                            Name = info.Name,
                            CommandLine = cmdLine,
                            Timestamp = DateTime.UtcNow
                        });
                    }
                }

                foreach (var pid in previousPids)
                {
                    if (!currentPids.Contains(pid))
                    {
                        _processTree.TryRemove(pid, out var exitedInfo);
                        OnProcessEvent?.Invoke(new ProcessEvent
                        {
                            Type = ProcessEventType.Exit,
                            Pid = pid,
                            ParentPid = exitedInfo?.ParentPid ?? 0,
                            Name = exitedInfo?.Name,
                            Timestamp = DateTime.UtcNow
                        });
                    }
                }

                previousPids = currentPids;

                var foreground = GetForegroundProcess(_rootPid);
                if (foreground != previousForeground)
                {
                    previousForeground = foreground;
                    var fgName = GetProcessName(foreground);
                    var fgCwd = GetProcessCwd(foreground);
                    var fgCmd = GetProcessCommandLine(foreground);

                    OnForegroundChanged?.Invoke(new ForegroundProcessInfo
                    {
                        Pid = foreground,
                        Name = fgName ?? "shell",
                        CommandLine = fgCmd,
                        Cwd = fgCwd
                    });
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"Process polling error: {ex.Message}");
            }
        }
    }

    public string? GetProcessCwd(int pid)
    {
        if (_disposed) return null;

        try
        {
            var cwdPath = $"/proc/{pid}/cwd";
            if (!File.Exists(cwdPath) && !Directory.Exists(Path.GetDirectoryName(cwdPath)))
            {
                return null;
            }

            var target = ReadLink(cwdPath);
            return target;
        }
        catch (Exception ex)
        {
            Log.Verbose(() => $"GetProcessCwd({pid}) failed: {ex.Message}");
            return null;
        }
    }

    private static string? ReadLink(string path)
    {
        try
        {
            var buffer = new byte[4096];
            var len = readlink(path, buffer, buffer.Length - 1);
            if (len < 0)
            {
                return null;
            }
            return System.Text.Encoding.UTF8.GetString(buffer, 0, len);
        }
        catch
        {
            return null;
        }
    }

    public string? GetProcessName(int pid)
    {
        if (_disposed) return null;

        try
        {
            var commPath = $"/proc/{pid}/comm";
            if (!File.Exists(commPath))
            {
                return null;
            }

            return File.ReadAllText(commPath).Trim();
        }
        catch
        {
            return null;
        }
    }

    public string? GetProcessCommandLine(int pid)
    {
        if (_disposed) return null;

        try
        {
            var cmdlinePath = $"/proc/{pid}/cmdline";
            if (!File.Exists(cmdlinePath))
            {
                return null;
            }

            var content = File.ReadAllBytes(cmdlinePath);
            if (content.Length == 0)
            {
                return null;
            }

            for (int i = 0; i < content.Length; i++)
            {
                if (content[i] == 0)
                {
                    content[i] = (byte)' ';
                }
            }

            return System.Text.Encoding.UTF8.GetString(content).Trim();
        }
        catch
        {
            return null;
        }
    }

    public IReadOnlyList<int> GetChildProcesses(int pid)
    {
        if (_disposed) return [];

        var children = new List<int>();
        try
        {
            var childrenPath = $"/proc/{pid}/task/{pid}/children";
            if (File.Exists(childrenPath))
            {
                var content = File.ReadAllText(childrenPath).Trim();
                if (!string.IsNullOrEmpty(content))
                {
                    foreach (var pidStr in content.Split(' ', StringSplitOptions.RemoveEmptyEntries))
                    {
                        if (int.TryParse(pidStr, out var childPid))
                        {
                            children.Add(childPid);
                        }
                    }
                }
                return children;
            }

            foreach (var dir in Directory.GetDirectories("/proc"))
            {
                var dirName = Path.GetFileName(dir);
                if (!int.TryParse(dirName, out var procPid))
                {
                    continue;
                }

                var statPath = Path.Combine(dir, "stat");
                if (!File.Exists(statPath))
                {
                    continue;
                }

                try
                {
                    var stat = File.ReadAllText(statPath);
                    var parentPid = ParsePpidFromStat(stat);
                    if (parentPid == pid)
                    {
                        children.Add(procPid);
                    }
                }
                catch { }
            }
        }
        catch { }

        return children;
    }

    private static int ParsePpidFromStat(string stat)
    {
        var closeParenIndex = stat.LastIndexOf(')');
        if (closeParenIndex < 0)
        {
            return 0;
        }

        var afterComm = stat[(closeParenIndex + 2)..];
        var fields = afterComm.Split(' ');
        if (fields.Length >= 2 && int.TryParse(fields[1], out var ppid))
        {
            return ppid;
        }

        return 0;
    }

    private int GetParentPid(int pid)
    {
        try
        {
            var statPath = $"/proc/{pid}/stat";
            if (!File.Exists(statPath))
            {
                return 0;
            }

            var stat = File.ReadAllText(statPath);
            return ParsePpidFromStat(stat);
        }
        catch
        {
            return 0;
        }
    }

    private IReadOnlyList<int> GetDescendantProcesses(int rootPid)
    {
        var descendants = new List<int>();
        var toVisit = new Queue<int>();
        toVisit.Enqueue(rootPid);

        while (toVisit.Count > 0)
        {
            var pid = toVisit.Dequeue();
            var children = GetChildProcesses(pid);
            foreach (var child in children)
            {
                if (!descendants.Contains(child))
                {
                    descendants.Add(child);
                    toVisit.Enqueue(child);
                }
            }
        }

        return descendants;
    }

    public int GetForegroundProcess(int shellPid)
    {
        if (_disposed) return shellPid;

        var descendants = GetDescendantProcesses(shellPid);
        if (descendants.Count == 0)
        {
            return shellPid;
        }

        var childrenMap = new Dictionary<int, List<int>>();
        childrenMap[shellPid] = [];

        foreach (var pid in descendants)
        {
            var parent = GetParentPid(pid);
            if (!childrenMap.ContainsKey(parent))
            {
                childrenMap[parent] = [];
            }
            childrenMap[parent].Add(pid);
            if (!childrenMap.ContainsKey(pid))
            {
                childrenMap[pid] = [];
            }
        }

        int FindLeaf(int current)
        {
            if (!childrenMap.TryGetValue(current, out var children) || children.Count == 0)
            {
                return current;
            }
            return FindLeaf(children[0]);
        }

        return FindLeaf(shellPid);
    }

    public ProcessTreeSnapshot GetProcessTreeSnapshot(int shellPid)
    {
        var processes = new List<ProcessInfo>();
        var descendants = GetDescendantProcesses(shellPid);

        foreach (var pid in descendants)
        {
            processes.Add(new ProcessInfo
            {
                Pid = pid,
                ParentPid = GetParentPid(pid),
                Name = GetProcessName(pid) ?? "unknown",
                CommandLine = GetProcessCommandLine(pid),
                Cwd = GetProcessCwd(pid)
            });
        }

        var foregroundPid = GetForegroundProcess(shellPid);
        ForegroundProcessInfo? foreground = null;
        if (foregroundPid != shellPid)
        {
            foreground = new ForegroundProcessInfo
            {
                Pid = foregroundPid,
                Name = GetProcessName(foregroundPid) ?? "unknown",
                CommandLine = GetProcessCommandLine(foregroundPid),
                Cwd = GetProcessCwd(foregroundPid)
            };
        }

        return new ProcessTreeSnapshot
        {
            ShellPid = shellPid,
            ShellCwd = GetProcessCwd(shellPid),
            Foreground = foreground,
            Processes = processes
        };
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        StopMonitoring();
    }

    #region Native Interop

    [DllImport("libc", SetLastError = true)]
    private static extern int readlink(
        [MarshalAs(UnmanagedType.LPStr)] string path,
        byte[] buf,
        int bufsiz);

    #endregion
}
#endif
