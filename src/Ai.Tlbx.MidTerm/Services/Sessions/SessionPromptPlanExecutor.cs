namespace Ai.Tlbx.MidTerm.Services.Sessions;

internal static class SessionPromptPlanExecutor
{
    internal static async Task ExecuteAsync(
        SessionApiEndpoints.SessionPromptExecutionPlan plan,
        Func<byte[], CancellationToken, Task> sendAsync,
        Func<int, CancellationToken, Task> delayAsync,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(sendAsync);
        ArgumentNullException.ThrowIfNull(delayAsync);

        if (plan.InterruptData is { Length: > 0 })
        {
            await sendAsync(plan.InterruptData, cancellationToken).ConfigureAwait(false);
            if (plan.InterruptDelayMs > 0)
            {
                await delayAsync(plan.InterruptDelayMs, cancellationToken).ConfigureAwait(false);
            }
        }

        await sendAsync(plan.PromptData, cancellationToken).ConfigureAwait(false);
        if (plan.SubmitDelayMs > 0)
        {
            await delayAsync(plan.SubmitDelayMs, cancellationToken).ConfigureAwait(false);
        }

        await sendAsync(plan.SubmitData, cancellationToken).ConfigureAwait(false);

        for (var i = 0; i < plan.FollowupSubmitCount; i++)
        {
            if (plan.FollowupSubmitDelayMs > 0)
            {
                await delayAsync(plan.FollowupSubmitDelayMs, cancellationToken).ConfigureAwait(false);
            }

            await sendAsync(plan.SubmitData, cancellationToken).ConfigureAwait(false);
        }
    }
}
