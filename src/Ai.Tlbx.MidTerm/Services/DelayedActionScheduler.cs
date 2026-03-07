namespace Ai.Tlbx.MidTerm.Services;

public static class DelayedActionScheduler
{
    private static readonly object s_lock = new();
    private static readonly Dictionary<int, Timer> s_timers = [];
    private static int s_nextId;

    public static void Schedule(TimeSpan delay, Action action)
    {
        ArgumentNullException.ThrowIfNull(action);

        var id = Interlocked.Increment(ref s_nextId);
        Timer? timer = null;

        timer = new Timer(_ =>
        {
            try
            {
                action();
            }
            finally
            {
                lock (s_lock)
                {
                    if (s_timers.Remove(id, out var activeTimer))
                    {
                        activeTimer.Dispose();
                    }
                }
            }
        }, null, delay, Timeout.InfiniteTimeSpan);

        lock (s_lock)
        {
            s_timers[id] = timer;
        }
    }
}
