using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace Ai.Tlbx.MidTerm.TtyHost;

/// <summary>
/// Answers Kitty graphics capability probes in the live PTY stream.
///
/// tlbx's terminal emulator is split between mthost and the browser. Handling
/// the query here keeps capability detection independent of browser attach and
/// replay timing, while image payloads continue to flow unchanged to xterm.js.
/// </summary>
internal sealed class KittyGraphicsCapabilityResponder
{
    private const int MaximumQueryBytes = 16 * 1024;
    private const int MaximumRememberedResponses = 64;
    private const byte Escape = 0x1b;
    private static readonly byte[] PrimaryDeviceAttributesResponse =
        Encoding.ASCII.GetBytes("\x1b[?62;4;9;22c");

    private readonly List<byte> _query = new(128);
    private readonly object _responseLock = new();
    private readonly List<byte[]> _rememberedResponses = [];
    private int _prefixLength;
    private int _primaryDeviceAttributesPrefixLength;
    private bool _capturing;
    private bool _escapePending;

    public List<byte[]>? Consume(ReadOnlySpan<byte> data)
    {
        List<byte[]>? responses = null;

        foreach (var value in data)
        {
            if (ConsumePrimaryDeviceAttributesPrefix(value))
            {
                RememberResponse(PrimaryDeviceAttributesResponse);
                responses ??= [];
                responses.Add(PrimaryDeviceAttributesResponse);
            }

            if (!_capturing)
            {
                ConsumePrefix(value);
                continue;
            }

            if (_escapePending)
            {
                if (value == (byte)'\\')
                {
                    var response = CreateResponse(_query);
                    if (response is not null)
                    {
                        RememberResponse(response);
                        responses ??= [];
                        responses.Add(response);
                    }

                    ResetCapture();
                    continue;
                }

                _query.Add(Escape);
                _escapePending = false;
            }

            if (value == Escape)
            {
                _escapePending = true;
                continue;
            }

            _query.Add(value);
            if (_query.Count > MaximumQueryBytes)
            {
                ResetCapture();
            }
        }

        return responses;
    }

    private bool ConsumePrimaryDeviceAttributesPrefix(byte value)
    {
        var expected = _primaryDeviceAttributesPrefixLength switch
        {
            0 => Escape,
            1 => (byte)'[',
            _ => (byte)'c'
        };

        if (value == expected)
        {
            _primaryDeviceAttributesPrefixLength++;
            if (_primaryDeviceAttributesPrefixLength == 3)
            {
                _primaryDeviceAttributesPrefixLength = 0;
                return true;
            }
            return false;
        }

        _primaryDeviceAttributesPrefixLength = value == Escape ? 1 : 0;
        return false;
    }

    /// <summary>
    /// Drops the browser renderer's duplicate answer to a capability query that
    /// mthost already answered. Keeping the answer in mthost makes discovery work
    /// before a browser attaches; suppressing the duplicate keeps it out of the
    /// application's stdin when that query is later rendered or replayed.
    /// </summary>
    public bool IsDuplicateClientResponse(ReadOnlySpan<byte> data)
    {
        lock (_responseLock)
        {
            foreach (var response in _rememberedResponses)
            {
                if (data.SequenceEqual(response))
                {
                    return true;
                }
            }

            return false;
        }
    }

    private void RememberResponse(byte[] response)
    {
        lock (_responseLock)
        {
            if (_rememberedResponses.Any(existing => response.AsSpan().SequenceEqual(existing)))
            {
                return;
            }

            if (_rememberedResponses.Count == MaximumRememberedResponses)
            {
                _rememberedResponses.RemoveAt(0);
            }

            _rememberedResponses.Add(response);
        }
    }

    private void ConsumePrefix(byte value)
    {
        var expected = _prefixLength switch
        {
            0 => Escape,
            1 => (byte)'_',
            _ => (byte)'G'
        };

        if (value == expected)
        {
            _prefixLength++;
            if (_prefixLength == 3)
            {
                _capturing = true;
                _prefixLength = 0;
                _query.Clear();
            }
            return;
        }

        _prefixLength = value == Escape ? 1 : 0;
    }

    private void ResetCapture()
    {
        _capturing = false;
        _escapePending = false;
        _prefixLength = 0;
        _query.Clear();
    }

    private static byte[]? CreateResponse(List<byte> query)
    {
        var separator = query.IndexOf((byte)';');
        var controlsLength = separator >= 0 ? separator : query.Count;
        var controls = Encoding.ASCII.GetString(CollectionsMarshal.AsSpan(query)[..controlsLength]);

        string? action = null;
        string? transmission = null;
        string? format = null;
        uint imageId = 0;
        var quiet = 0;

        foreach (var item in controls.Split(',', StringSplitOptions.RemoveEmptyEntries))
        {
            var equals = item.IndexOf('=', StringComparison.Ordinal);
            if (equals <= 0 || equals == item.Length - 1)
            {
                continue;
            }

            var key = item[..equals];
            var value = item[(equals + 1)..];
            switch (key)
            {
                case "a":
                    action = value;
                    break;
                case "t":
                    transmission = value;
                    break;
                case "f":
                    format = value;
                    break;
                case "i":
                    _ = uint.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out imageId);
                    break;
                case "q":
                    _ = int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out quiet);
                    break;
            }
        }

        if (!string.Equals(action, "q", StringComparison.Ordinal))
        {
            return null;
        }

        var directTransfer = transmission is null or "d";
        var supportedFormat = format is null or "24" or "32" or "100";
        var ok = directTransfer && supportedFormat;
        if ((ok && quiet >= 1) || (!ok && quiet >= 2))
        {
            return null;
        }

        var message = !directTransfer
            ? "EINVAL:unsupported transmission medium"
            : !supportedFormat
                ? "EINVAL:unsupported format"
                : "OK";
        return Encoding.ASCII.GetBytes(string.Create(
            CultureInfo.InvariantCulture,
            $"\x1b_Gi={imageId};{message}\x1b\\"));
    }
}
