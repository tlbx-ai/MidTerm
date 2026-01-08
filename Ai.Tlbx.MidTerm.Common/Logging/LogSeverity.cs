using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Common.Logging;

public enum LogSeverity
{
    [JsonStringEnumMemberName("exception")] Exception = 0,
    [JsonStringEnumMemberName("error")] Error = 1,
    [JsonStringEnumMemberName("warn")] Warn = 2,
    [JsonStringEnumMemberName("info")] Info = 3,
    [JsonStringEnumMemberName("verbose")] Verbose = 4
}
