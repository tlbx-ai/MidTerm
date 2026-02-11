using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class CommandService
{
    private readonly ConcurrentDictionary<string, CommandRun> _activeRuns = new();

    private sealed class CommandRun
    {
        public Channel<string> OutputChannel { get; } = Channel.CreateUnbounded<string>();
        public CancellationTokenSource Cts { get; } = new();
        public CommandRunStatus Status { get; set; } = new();
        public Process? CurrentProcess { get; set; }
    }

    private static string GetCommandsDir(string basePath)
    {
        return Path.Combine(basePath, ".midterm", "commands");
    }

    public CommandListResponse ListCommands(string workingDirectory)
    {
        var dir = GetCommandsDir(workingDirectory);
        var response = new CommandListResponse { CommandsDirectory = dir };

        if (!Directory.Exists(dir))
        {
            return response;
        }

        var commands = new List<CommandDefinition>();
        foreach (var file in Directory.EnumerateFiles(dir, "*.txt").OrderBy(f => f))
        {
            var cmd = ParseCommandFile(file);
            if (cmd is not null)
            {
                commands.Add(cmd);
            }
        }

        response.Commands = commands.ToArray();
        return response;
    }

    private static CommandDefinition? ParseCommandFile(string filePath)
    {
        try
        {
            var lines = File.ReadAllLines(filePath);
            if (lines.Length < 3)
            {
                return null;
            }

            var filename = Path.GetFileName(filePath);
            var orderMatch = Regex.Match(filename, @"^(\d+)_");
            var order = orderMatch.Success ? int.Parse(orderMatch.Groups[1].Value) : 0;

            return new CommandDefinition
            {
                Filename = filename,
                Name = lines[0].Trim(),
                Description = lines[1].Trim(),
                Commands = lines.Skip(2).Where(l => !string.IsNullOrWhiteSpace(l)).ToArray(),
                Order = order
            };
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"Failed to parse command file {filePath}: {ex.Message}");
            return null;
        }
    }

    public CommandDefinition CreateCommand(string workingDirectory, string name, string description, string[] commands)
    {
        var dir = GetCommandsDir(workingDirectory);
        Directory.CreateDirectory(dir);

        var existing = Directory.Exists(dir) ? Directory.GetFiles(dir, "*.txt").Length : 0;
        var order = existing + 1;
        var slug = Slugify(name);
        var filename = $"{order}_{slug}.txt";
        var filePath = Path.Combine(dir, filename);

        var content = $"{name}\n{description}\n{string.Join('\n', commands)}";
        File.WriteAllText(filePath, content);

        return new CommandDefinition
        {
            Filename = filename,
            Name = name,
            Description = description,
            Commands = commands,
            Order = order
        };
    }

    public CommandDefinition? UpdateCommand(string workingDirectory, string filename, string name, string description, string[] commands)
    {
        var filePath = Path.Combine(GetCommandsDir(workingDirectory), filename);
        if (!File.Exists(filePath))
        {
            return null;
        }

        var content = $"{name}\n{description}\n{string.Join('\n', commands)}";
        File.WriteAllText(filePath, content);

        var orderMatch = Regex.Match(filename, @"^(\d+)_");
        var order = orderMatch.Success ? int.Parse(orderMatch.Groups[1].Value) : 0;

        return new CommandDefinition
        {
            Filename = filename,
            Name = name,
            Description = description,
            Commands = commands,
            Order = order
        };
    }

    public bool DeleteCommand(string workingDirectory, string filename)
    {
        var filePath = Path.Combine(GetCommandsDir(workingDirectory), filename);
        if (!File.Exists(filePath))
        {
            return false;
        }

        File.Delete(filePath);
        return true;
    }

    public void ReorderCommands(string workingDirectory, string[] filenames)
    {
        var dir = GetCommandsDir(workingDirectory);
        if (!Directory.Exists(dir))
        {
            return;
        }

        var tempNames = new List<(string TempPath, string FinalPath)>();
        for (var i = 0; i < filenames.Length; i++)
        {
            var oldPath = Path.Combine(dir, filenames[i]);
            if (!File.Exists(oldPath))
            {
                continue;
            }

            var nameWithoutOrder = Regex.Replace(filenames[i], @"^\d+_", "");
            var newFilename = $"{i + 1}_{nameWithoutOrder}";
            var tempPath = Path.Combine(dir, $"_reorder_temp_{i}_{nameWithoutOrder}");
            var finalPath = Path.Combine(dir, newFilename);

            File.Move(oldPath, tempPath);
            tempNames.Add((tempPath, finalPath));
        }

        foreach (var (tempPath, finalPath) in tempNames)
        {
            File.Move(tempPath, finalPath);
        }
    }

    public string RunCommand(string workingDirectory, string filename, string shellType)
    {
        var filePath = Path.Combine(GetCommandsDir(workingDirectory), filename);
        var cmd = ParseCommandFile(filePath);
        if (cmd is null)
        {
            throw new InvalidOperationException("Command file not found or invalid");
        }

        var runId = Guid.NewGuid().ToString("N")[..12];
        var run = new CommandRun
        {
            Status = new CommandRunStatus
            {
                RunId = runId,
                Status = "running",
                TotalSteps = cmd.Commands.Length
            }
        };
        _activeRuns[runId] = run;

        _ = ExecuteCommandsAsync(run, cmd.Commands, workingDirectory, shellType);

        return runId;
    }

    private async Task ExecuteCommandsAsync(CommandRun run, string[] commands, string workingDirectory, string shellType)
    {
        var writer = run.OutputChannel.Writer;

        try
        {
            for (var i = 0; i < commands.Length; i++)
            {
                if (run.Cts.Token.IsCancellationRequested)
                {
                    run.Status.Status = "cancelled";
                    await writer.WriteAsync("\n--- Cancelled ---\n");
                    break;
                }

                run.Status.CurrentStep = i + 1;
                await writer.WriteAsync($"$ {commands[i]}\n");

                var (shell, args) = GetShellCommand(commands[i], shellType);

                var psi = new ProcessStartInfo
                {
                    FileName = shell,
                    Arguments = args,
                    WorkingDirectory = workingDirectory,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };

                using var process = new Process { StartInfo = psi };
                run.CurrentProcess = process;

                process.OutputDataReceived += (_, e) =>
                {
                    if (e.Data is not null)
                    {
                        writer.TryWrite(e.Data + "\n");
                    }
                };

                process.ErrorDataReceived += (_, e) =>
                {
                    if (e.Data is not null)
                    {
                        writer.TryWrite(e.Data + "\n");
                    }
                };

                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();

                await process.WaitForExitAsync(run.Cts.Token);
                run.CurrentProcess = null;

                if (process.ExitCode != 0)
                {
                    run.Status.ExitCode = process.ExitCode;
                    run.Status.Status = "failed";
                    await writer.WriteAsync($"\n--- Step {i + 1} failed with exit code {process.ExitCode} ---\n");
                    break;
                }

                if (i == commands.Length - 1)
                {
                    run.Status.ExitCode = 0;
                    run.Status.Status = "completed";
                }
            }
        }
        catch (OperationCanceledException)
        {
            run.Status.Status = "cancelled";
            await writer.WriteAsync("\n--- Cancelled ---\n");
        }
        catch (Exception ex)
        {
            run.Status.Status = "failed";
            await writer.WriteAsync($"\n--- Error: {ex.Message} ---\n");
            Log.Error(() => $"Command execution error: {ex.Message}");
        }
        finally
        {
            run.CurrentProcess = null;
            writer.Complete();

            _ = CleanupRunAsync(run.Status.RunId);
        }
    }

    private static (string shell, string args) GetShellCommand(string command, string shellType)
    {
        if (OperatingSystem.IsWindows())
        {
            return shellType.Equals("cmd", StringComparison.OrdinalIgnoreCase)
                ? ("cmd.exe", $"/c {command}")
                : ("pwsh", $"-NoProfile -Command {command}");
        }
        return ("bash", $"-c \"{command.Replace("\"", "\\\"")}\"");
    }

    private async Task CleanupRunAsync(string runId)
    {
        await Task.Delay(TimeSpan.FromMinutes(5));
        _activeRuns.TryRemove(runId, out _);
    }

    public CommandRunStatus? GetRunStatus(string runId)
    {
        return _activeRuns.TryGetValue(runId, out var run) ? run.Status : null;
    }

    public ChannelReader<string>? GetRunOutput(string runId)
    {
        return _activeRuns.TryGetValue(runId, out var run) ? run.OutputChannel.Reader : null;
    }

    public bool CancelRun(string runId)
    {
        if (!_activeRuns.TryGetValue(runId, out var run))
        {
            return false;
        }

        run.Cts.Cancel();
        try
        {
            run.CurrentProcess?.Kill(true);
        }
        catch
        {
            // Process may have already exited
        }
        return true;
    }

    private static string Slugify(string name)
    {
        var slug = Regex.Replace(name.ToLowerInvariant(), @"[^a-z0-9]+", "-").Trim('-');
        return string.IsNullOrEmpty(slug) ? "command" : slug;
    }
}
