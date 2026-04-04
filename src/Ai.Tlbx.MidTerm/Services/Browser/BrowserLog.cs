using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Ai.Tlbx.MidTerm.Services.Browser;

public static partial class BrowserLog
{
    private static StreamWriter? _writer;
    private static readonly Lock _lock = new();
    private const int MaxResultLength = 500;

    [GeneratedRegex(@"\x1B(?:\][^\x07]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|\([AB012]|[@-Z\\-_])", RegexOptions.None, 1000)]
    private static partial Regex AnsiEscapePattern();

    public static void Initialize(string logDirectory)
    {
        lock (_lock)
        {
            try
            {
                Directory.CreateDirectory(logDirectory);
                var path = Path.Combine(logDirectory, "browser.log");
                _writer?.Dispose();
                _writer = new StreamWriter(path, append: true) { AutoFlush = true };
                Write("BrowserLog initialized");
            }
            catch
            {
            }
        }
    }

    public static void Command(string command, string? args)
    {
        Write($">> {command}{(args is not null ? $" {Sanitize(args)}" : "")}");
    }

    public static void Result(string command, bool success, string output)
    {
        var status = success ? "OK" : "FAIL";
        var sanitized = Sanitize(output).TrimEnd('\n', '\r');

        if (string.IsNullOrEmpty(sanitized))
        {
            Write($"   << {status}");
            return;
        }

        if (sanitized.Length > MaxResultLength)
        {
            sanitized = sanitized[..MaxResultLength] + $"... ({sanitized.Length} chars total)";
        }

        Write($"   << {status}: {sanitized}");
    }

    public static void Error(string message)
    {
        Write($"   !! {message}");
    }

    public static void Info(string message)
    {
        Write($"   ~~ {message}");
    }

    public static void Shutdown()
    {
        lock (_lock)
        {
            _writer?.Dispose();
            _writer = null;
        }
    }

    private static string Sanitize(string input)
    {
        var withoutEscapes = AnsiEscapePattern().Replace(input, "");
        var sb = new StringBuilder(withoutEscapes.Length);
        foreach (var c in withoutEscapes)
        {
            if (c is '\n' or '\r' or '\t')
            {
                sb.Append(c switch { '\n' => "\\n", '\r' => "\\r", _ => "\\t" });
            }
            else if (char.IsControl(c))
            {
                sb.Append(string.Create(CultureInfo.InvariantCulture, $"\\x{(int)c:X2}"));
            }
            else
            {
                sb.Append(c);
            }
        }
        return sb.ToString();
    }

    private static void Write(string message)
    {
        lock (_lock)
        {
            _writer?.WriteLine(string.Create(CultureInfo.InvariantCulture, $"{DateTime.UtcNow:HH:mm:ss.fff} {message}"));
        }
    }
}
