using System.Buffers;
using System.Text;
using Ai.Tlbx.MiddleManager.Pty;
using Ai.Tlbx.MiddleManager.Common.Shells;

namespace Ai.Tlbx.MiddleManager.Services
{
    public sealed class TerminalSession : IDisposable
    {
        private readonly IPtyConnection _connection;
        private readonly CancellationTokenSource _cts;
        private readonly StringBuilder _outputBuffer = new();
        private readonly object _bufferLock = new();
        private const int MaxBufferSize = 100_000;
        private bool _disposed;

        public string Id { get; }
        public int Pid => _connection.Pid;
        public DateTime CreatedAt { get; }
        public bool IsRunning => !_disposed && _connection.IsRunning;
        public int? ExitCode => _connection.ExitCode;
        public string? CurrentWorkingDirectory { get; private set; }
        public int Cols { get; private set; }
        public int Rows { get; private set; }
        public ShellType ShellType { get; private set; }
        public string? Name { get; private set; }
        public bool ManuallyNamed { get; private set; }

        /// <summary>
        /// Temp directory for file drops and clipboard uploads. Created on first use.
        /// </summary>
        public string TempDirectory => _tempDirectory ??= CreateTempDirectory();
        private string? _tempDirectory;

        public void SetName(string? name, bool isManual = true)
        {
            if (isManual)
            {
                ManuallyNamed = true;
            }
            else if (ManuallyNamed)
            {
                return;
            }
            Name = string.IsNullOrWhiteSpace(name) ? null : name.Trim();
            OnStateChanged?.Invoke();
        }

        public event Action? OnStateChanged;
        public event Func<string, ReadOnlyMemory<byte>, Task>? OnOutput;

        private TerminalSession(string id, IPtyConnection connection)
        {
            Id = id;
            _connection = connection;
            _cts = new CancellationTokenSource();
            CreatedAt = DateTime.UtcNow;
        }

        public static TerminalSession Create(
            string workingDirectory,
            int cols,
            int rows,
            IShellConfiguration shellConfig,
            string? runAsUser = null,
            string? runAsUserSid = null,
            int? runAsUid = null,
            int? runAsGid = null)
        {
            var id = Guid.NewGuid().ToString("N")[..8];

            var connection = PtyConnectionFactory.Create(
                shellConfig.ExecutablePath,
                shellConfig.Arguments,
                workingDirectory,
                cols,
                rows,
                shellConfig.GetEnvironmentVariables(),
                runAsUser,
                runAsUserSid,
                runAsUid,
                runAsGid);

            var session = new TerminalSession(id, connection)
            {
                Cols = cols,
                Rows = rows,
                ShellType = shellConfig.ShellType
            };
            session.StartReadLoop();
            return session;
        }

        private void StartReadLoop()
        {
            _ = Task.Run(async () =>
            {
                const int bufferSize = 8192;
                var buffer = ArrayPool<byte>.Shared.Rent(bufferSize);

                try
                {
                    var reader = _connection.ReaderStream;

                    while (!_cts.Token.IsCancellationRequested)
                    {
                        int bytesRead;
                        try
                        {
                            bytesRead = await reader.ReadAsync(
                                buffer.AsMemory(0, bufferSize),
                                _cts.Token).ConfigureAwait(false);
                        }
                        catch (OperationCanceledException)
                        {
                            break;
                        }
                        catch (ObjectDisposedException)
                        {
                            break;
                        }
                        catch (IOException)
                        {
                            break;
                        }

                        if (bytesRead == 0)
                        {
                            break;
                        }

                        var data = buffer.AsMemory(0, bytesRead);

                        // Buffer output for replay
                        AppendToBuffer(data.Span);

                        // Parse OSC sequences for CWD
                        ParseOscSequences(data.Span);

                        // Notify subscribers (mux manager)
                        var outputHandler = OnOutput;
                        if (outputHandler is not null)
                        {
                            await outputHandler(Id, data).ConfigureAwait(false);
                        }
                    }
                }
                catch
                {
                    // Read loop error - process likely exited
                }
                finally
                {
                    ArrayPool<byte>.Shared.Return(buffer);
                    OnStateChanged?.Invoke();
                }
            });
        }

        private void AppendToBuffer(ReadOnlySpan<byte> data)
        {
            var text = Encoding.UTF8.GetString(data);
            lock (_bufferLock)
            {
                _outputBuffer.Append(text);
                if (_outputBuffer.Length > MaxBufferSize)
                {
                    _outputBuffer.Remove(0, _outputBuffer.Length - MaxBufferSize);
                }
            }
        }

        private void ParseOscSequences(ReadOnlySpan<byte> data)
        {
            var text = Encoding.UTF8.GetString(data);
            var path = ParseOsc7Path(text);
            if (path is not null && CurrentWorkingDirectory != path)
            {
                CurrentWorkingDirectory = path;
                OnStateChanged?.Invoke();
            }
        }

        /// <summary>
        /// Parses OSC 7 working directory sequence from terminal output.
        /// Format: ESC]7;file://hostname/path BEL
        /// </summary>
        internal static string? ParseOsc7Path(string text)
        {
            var oscStart = text.IndexOf("\x1b]7;", StringComparison.Ordinal);
            if (oscStart < 0)
            {
                return null;
            }

            var uriStart = oscStart + 4;
            var oscEnd = text.IndexOfAny(['\x07', '\x1b'], uriStart);
            if (oscEnd <= uriStart)
            {
                return null;
            }

            var uri = text.Substring(uriStart, oscEnd - uriStart);
            if (!uri.StartsWith("file://", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            try
            {
                var pathStart = uri.IndexOf('/', 7);
                if (pathStart < 0)
                {
                    return null;
                }

                var path = Uri.UnescapeDataString(uri.Substring(pathStart));
                if (path.Length > 2 && path[0] == '/' && path[2] == ':')
                {
                    path = path.Substring(1);
                }
                return path;
            }
            catch
            {
                return null;
            }
        }

        public string GetBuffer()
        {
            lock (_bufferLock)
            {
                return _outputBuffer.ToString();
            }
        }

        public async Task SendInputAsync(string data)
        {
            if (_disposed || string.IsNullOrEmpty(data))
            {
                return;
            }

            try
            {
                var bytes = Encoding.UTF8.GetBytes(data);
                await _connection.WriterStream.WriteAsync(bytes).ConfigureAwait(false);
                await _connection.WriterStream.FlushAsync().ConfigureAwait(false);
            }
            catch
            {
                // Write failure - process may have exited
            }
        }

        public bool Resize(int cols, int rows)
        {
            if (_disposed)
            {
                return false;
            }

            if (Cols == cols && Rows == rows)
            {
                return true;
            }

            Cols = cols;
            Rows = rows;
            _connection.Resize(cols, rows);
            OnStateChanged?.Invoke();
            return true;
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;

            try { _cts.Cancel(); } catch { }
            try { _cts.Dispose(); } catch { }
            try { _connection.Dispose(); } catch { }
            CleanupTempDirectory();
        }

        private string CreateTempDirectory()
        {
            var tempPath = Path.Combine(Path.GetTempPath(), "mm-drops", Id);
            Directory.CreateDirectory(tempPath);
            return tempPath;
        }

        private void CleanupTempDirectory()
        {
            if (_tempDirectory is null)
            {
                return;
            }

            try
            {
                if (Directory.Exists(_tempDirectory))
                {
                    Directory.Delete(_tempDirectory, recursive: true);
                }
            }
            catch
            {
                // Best effort cleanup - files may be locked
            }
        }
    }
}
