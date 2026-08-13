using System.Threading.Channels;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

/// <summary>
/// Resolves notification priority once per event and attempts native delivery
/// before forwarding the event to browser clients. This prevents one native
/// notification per connected State WebSocket and preserves browser fallback.
/// </summary>
public sealed class TerminalNotificationDeliveryService : BackgroundService
{
    private readonly SessionTelemetryService _telemetry;
    private readonly TtyHostSessionManager _sessionManager;
    private readonly SettingsService _settingsService;
    private readonly Channel<TerminalNotificationMessage> _pending = Channel.CreateBounded<TerminalNotificationMessage>(
        new BoundedChannelOptions(256)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.DropOldest
        });

    public event Action<TerminalNotificationMessage>? NotificationReady;

    public TerminalNotificationDeliveryService(
        SessionTelemetryService telemetry,
        TtyHostSessionManager sessionManager,
        SettingsService settingsService)
    {
        _telemetry = telemetry;
        _sessionManager = sessionManager;
        _settingsService = settingsService;
        _telemetry.TerminalNotificationReceived += OnNotificationReceived;
    }

    private void OnNotificationReceived(TerminalNotificationMessage notification)
    {
        _pending.Writer.TryWrite(notification);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var notification in _pending.Reader.ReadAllAsync(stoppingToken).ConfigureAwait(false))
        {
            try
            {
                NotificationReady?.Invoke(await DeliverAsync(notification, stoppingToken).ConfigureAwait(false));
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                Log.Exception(ex, "TerminalNotificationDeliveryService.Deliver");
                NotificationReady?.Invoke(WithDelivery(notification, ResolvePriority(notification), nativeHandled: false));
            }
        }
    }

    private async Task<TerminalNotificationMessage> DeliverAsync(
        TerminalNotificationMessage notification,
        CancellationToken ct)
    {
        var priority = ResolvePriority(notification);
        var settings = _settingsService.Load();
        var wantsDesktopNotification = settings.BellStyle is BellStyleSetting.Notification or BellStyleSetting.Both;
        if (priority != NotificationPrioritySetting.Important || !wantsDesktopNotification)
        {
            return WithDelivery(notification, priority, nativeHandled: false);
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(3));
        var result = await _sessionManager.ShowNativeNotificationAsync(
            notification.SessionId,
            new TtyHostNotificationRequest
            {
                Title = notification.Title ?? "tlbx",
                Body = notification.Body ?? "Terminal attention requested",
                Tag = notification.SessionId,
                Urgent = true
            },
            timeout.Token).ConfigureAwait(false);

        if (!result.Success && !string.IsNullOrWhiteSpace(result.Error))
        {
            Log.Warn(() => $"Native notification fallback for session {notification.SessionId}: {result.Error}");
        }

        return WithDelivery(notification, priority, result.Success);
    }

    private NotificationPrioritySetting ResolvePriority(TerminalNotificationMessage notification)
    {
        return notification.Priority ?? _settingsService.Load().NotificationPriority;
    }

    private static TerminalNotificationMessage WithDelivery(
        TerminalNotificationMessage source,
        NotificationPrioritySetting priority,
        bool nativeHandled)
    {
        return new TerminalNotificationMessage
        {
            SessionId = source.SessionId,
            Protocol = source.Protocol,
            Title = source.Title,
            Body = source.Body,
            Force = source.Force,
            Priority = priority,
            NativeHandled = nativeHandled
        };
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        _telemetry.TerminalNotificationReceived -= OnNotificationReceived;
        _pending.Writer.TryComplete();
        await base.StopAsync(cancellationToken).ConfigureAwait(false);
    }
}
