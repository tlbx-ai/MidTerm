using System.Diagnostics;

namespace Ai.Tlbx.MidTerm.Tests;

public static class TestCleanupHelper
{
    private static readonly HashSet<int> BaselineHostProcessIds = CaptureHostProcessIds();
    private static readonly string[] TestBuildPathPatterns =
    [
        @"\bin\Debug\",
        @"\bin\Release\",
        @"/bin/Debug/",
        @"/bin/Release/"
    ];

    public static List<Process> GetOrphanTestMthostProcesses()
    {
        var orphans = new List<Process>();

        foreach (var proc in GetCandidateHostProcesses())
        {
            var keepProcess = false;
            try
            {
                if (!BaselineHostProcessIds.Contains(proc.Id))
                {
                    var path = proc.MainModule?.FileName;
                    if (path is not null && IsTestBuildPath(path))
                    {
                        orphans.Add(proc);
                        keepProcess = true;
                    }
                }
            }
            catch
            {
                // Access denied or process exited - skip
            }
            finally
            {
                if (!keepProcess)
                {
                    proc.Dispose();
                }
            }
        }

        return orphans;
    }

    public static int KillOrphanTestProcesses()
    {
        var killed = 0;
        foreach (var proc in GetOrphanTestMthostProcesses())
        {
            try
            {
                proc.Kill();
                proc.WaitForExit(5000);
                killed++;
            }
            catch { }
            finally
            {
                proc.Dispose();
            }
        }
        return killed;
    }

    private static bool IsTestBuildPath(string path)
    {
        return TestBuildPathPatterns.Any(pattern =>
            path.Contains(pattern, StringComparison.OrdinalIgnoreCase));
    }

    private static HashSet<int> CaptureHostProcessIds()
    {
        var ids = new HashSet<int>();
        foreach (var proc in GetCandidateHostProcesses())
        {
            try
            {
                ids.Add(proc.Id);
            }
            finally
            {
                proc.Dispose();
            }
        }

        return ids;
    }

    private static IEnumerable<Process> GetCandidateHostProcesses()
    {
        return Process.GetProcessesByName("mthost")
            .Concat(Process.GetProcessesByName("mmttyhost"));
    }
}
