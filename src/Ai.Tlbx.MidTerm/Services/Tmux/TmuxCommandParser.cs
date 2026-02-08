namespace Ai.Tlbx.MidTerm.Services.Tmux;

/// <summary>
/// Parses tmux CLI arguments into structured commands.
/// Handles chained commands separated by \; (semicolons).
/// </summary>
public static class TmuxCommandParser
{
    /// <summary>
    /// A single parsed tmux command with its name, flags, and positional arguments.
    /// </summary>
    public sealed class ParsedCommand
    {
        public string Name { get; init; } = "";
        public Dictionary<string, string?> Flags { get; init; } = new();
        public List<string> Positional { get; init; } = [];

        /// <summary>Check whether a flag (e.g. "-l") was present.</summary>
        public bool HasFlag(string flag) => Flags.ContainsKey(flag);

        /// <summary>Get the value of a flag (e.g. "-t %1" → "%1"), or null if absent.</summary>
        public string? GetFlag(string flag) => Flags.GetValueOrDefault(flag);
    }

    /// <summary>
    /// Parse null-delimited bytes from the request body into argument strings.
    /// </summary>
    public static List<string> ParseNullDelimitedArgs(byte[] body)
    {
        var args = new List<string>();
        var start = 0;
        for (var i = 0; i < body.Length; i++)
        {
            if (body[i] == 0)
            {
                if (i > start)
                {
                    args.Add(System.Text.Encoding.UTF8.GetString(body, start, i - start));
                }
                start = i + 1;
            }
        }
        if (start < body.Length)
        {
            args.Add(System.Text.Encoding.UTF8.GetString(body, start, body.Length - start));
        }
        return args;
    }

    /// <summary>
    /// Split args into chained commands (separated by ; or \;).
    /// Then parse each into a ParsedCommand.
    /// </summary>
    public static List<ParsedCommand> Parse(List<string> args)
    {
        var commands = new List<ParsedCommand>();
        var current = new List<string>();

        foreach (var arg in args)
        {
            if (arg is ";" or "\\;")
            {
                if (current.Count > 0)
                {
                    commands.Add(ParseSingle(current));
                    current = [];
                }
            }
            else
            {
                current.Add(arg);
            }
        }

        if (current.Count > 0)
        {
            commands.Add(ParseSingle(current));
        }

        return commands;
    }

    private static ParsedCommand ParseSingle(List<string> args)
    {
        if (args.Count == 0)
        {
            return new ParsedCommand();
        }

        var name = args[0];
        var flags = new Dictionary<string, string?>();
        var positional = new List<string>();

        var i = 1;
        while (i < args.Count)
        {
            var arg = args[i];

            if (arg.StartsWith('-') && arg.Length >= 2 && !IsNegativeNumber(arg))
            {
                // Combined short flags: -ahv → -a, -h, -v (all boolean)
                // Flags with values: -t %1, -F "format", -c /path
                var flagChars = arg[1..];

                if (flagChars.Length == 1 && FlagTakesValue(name, flagChars[0]))
                {
                    // Single flag that takes a value
                    var flagName = $"-{flagChars[0]}";
                    if (i + 1 < args.Count)
                    {
                        flags[flagName] = args[++i];
                    }
                    else
                    {
                        flags[flagName] = null;
                    }
                }
                else
                {
                    // Combined boolean flags or long flag
                    foreach (var c in flagChars)
                    {
                        if (FlagTakesValue(name, c))
                        {
                            // This flag takes a value — consume next arg
                            var flagName = $"-{c}";
                            if (i + 1 < args.Count)
                            {
                                flags[flagName] = args[++i];
                            }
                            else
                            {
                                flags[flagName] = null;
                            }
                            break;
                        }
                        else
                        {
                            flags[$"-{c}"] = null;
                        }
                    }
                }
            }
            else if (arg == "--")
            {
                // Everything after -- is positional
                for (var j = i + 1; j < args.Count; j++)
                {
                    positional.Add(args[j]);
                }
                break;
            }
            else
            {
                positional.Add(arg);
            }

            i++;
        }

        return new ParsedCommand { Name = name, Flags = flags, Positional = positional };
    }

    private static bool IsNegativeNumber(string arg) =>
        arg.Length >= 2 && arg[0] == '-' && char.IsDigit(arg[1]);

    /// <summary>
    /// Determines if a flag character takes a value argument for a given command.
    /// </summary>
    private static bool FlagTakesValue(string command, char flag) => command switch
    {
        "split-window" => flag is 'c' or 'l' or 't' or 'F' or 'e',
        "select-pane" => flag is 't' or 'T',
        "send-keys" => flag is 't' or 'N',
        "resize-pane" => flag is 't' or 'x' or 'y',
        "list-panes" => flag is 't' or 'F' or 'f',
        "list-sessions" => flag is 'F' or 'f',
        "list-windows" => flag is 't' or 'F' or 'f',
        "new-window" => flag is 'c' or 'n' or 't' or 'F' or 'e',
        "kill-pane" => flag is 't',
        "kill-window" => flag is 't',
        "has-session" => flag is 't',
        "display-message" => flag is 't' or 'c',
        "capture-pane" => flag is 't' or 'b' or 'S' or 'E',
        "select-window" => flag is 't',
        "swap-pane" => flag is 's' or 't',
        "rename-session" => flag is 't',
        "rename-window" => flag is 't',
        "run-shell" => flag is 't' or 'd',
        "display-popup" => flag is 'w' or 'h' or 'x' or 'y' or 'c' or 't' or 'E' or 'e' or 'd' or 'T',
        "show-options" or "show-option" => flag is 't',
        "set-option" or "set" => flag is 't',
        "wait-for" => false,
        _ => flag is 't' or 'F' or 'f'
    };
}
