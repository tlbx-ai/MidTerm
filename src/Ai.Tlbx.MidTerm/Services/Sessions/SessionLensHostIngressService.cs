using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public sealed class SessionLensHostIngressService
{
    private readonly SessionLensPulseService _pulse;

    public SessionLensHostIngressService(SessionLensPulseService pulse)
    {
        _pulse = pulse;
    }

    public void ValidateHello(LensHostHello hello)
    {
        ArgumentNullException.ThrowIfNull(hello);
        EnsureProtocolVersion(hello.ProtocolVersion);
    }

    public void ApplyEvent(LensHostEventEnvelope envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        EnsureProtocolVersion(envelope.ProtocolVersion);

        if (envelope.Event is null)
        {
            throw new InvalidOperationException("Lens host event payload is required.");
        }

        if (string.IsNullOrWhiteSpace(envelope.SessionId))
        {
            throw new InvalidOperationException("Lens host event envelope must include a session id.");
        }

        if (string.IsNullOrWhiteSpace(envelope.Event.SessionId))
        {
            envelope.Event.SessionId = envelope.SessionId;
        }
        else if (!string.Equals(envelope.Event.SessionId, envelope.SessionId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Lens host event envelope session id does not match the event payload session id.");
        }

        _pulse.Append(envelope.Event);
    }

    public void ApplyEvents(IEnumerable<LensHostEventEnvelope> events)
    {
        ArgumentNullException.ThrowIfNull(events);
        foreach (var envelope in events)
        {
            ApplyEvent(envelope);
        }
    }

    private static void EnsureProtocolVersion(string? protocolVersion)
    {
        if (!string.Equals(protocolVersion, LensHostProtocol.CurrentVersion, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"Unsupported Lens host protocol version '{protocolVersion ?? "(null)"}'. Expected '{LensHostProtocol.CurrentVersion}'.");
        }
    }
}
