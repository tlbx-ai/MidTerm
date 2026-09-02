using System.Globalization;
using System.Text.Json;
using Ai.Tlbx.MidTerm.AgentHost;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Xunit;

namespace Ai.Tlbx.MidTerm.AgentHost.UnitTests;

public sealed class AppServerControlToolPresentationProjectorTests
{
    [Fact]
    public void FromCodex_ProjectsCommandAndBoundedFailureEvidence()
    {
        using var document = JsonDocument.Parse(
            """
            {
              "item": {
                "type": "commandExecution",
                "command": "dotnet test",
                "exitCode": 1,
                "stderr": "first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh"
              }
            }
            """);

        var presentation = AppServerControlToolPresentationProjector.FromCodex(
            "command_execution",
            "failed",
            "Command failed",
            document.RootElement);

        Assert.Equal("command", presentation.Category);
        Assert.Equal("Ran command", presentation.Label);
        Assert.Equal("dotnet test", presentation.Subject);
        Assert.Equal(1, presentation.ExitCode);
        Assert.Equal("error", presentation.EvidenceKind);
        Assert.DoesNotContain("first", presentation.Evidence, StringComparison.Ordinal);
        Assert.Contains("seventh", presentation.Evidence, StringComparison.Ordinal);
        Assert.Equal(1, presentation.OmittedLineCount);
    }

    [Fact]
    public void FromClaude_UsesStructuredToolIdentityAndPath()
    {
        using var document = JsonDocument.Parse("""{"file_path":"Q:\\repos\\tlbx\\README.md"}""");

        var presentation = AppServerControlToolPresentationProjector.FromClaude(
            "Read",
            "in_progress",
            document.RootElement);

        Assert.Equal("read", presentation.Category);
        Assert.Equal("Read file", presentation.Label);
        Assert.Equal("Q:\\repos\\tlbx\\README.md", presentation.Subject);
        Assert.Equal(["Q:\\repos\\tlbx\\README.md"], presentation.Paths);
    }

    [Fact]
    public void FromAcp_UsesKindAndSearchPatternWithoutSerializingRawInput()
    {
        using var document = JsonDocument.Parse("""{"pattern":"ToolPresentation","path":"src"}""");

        var presentation = AppServerControlToolPresentationProjector.FromAcp(
            "dynamic_tool_call",
            "completed",
            "Search source",
            "search",
            document.RootElement);

        Assert.Equal("search", presentation.Category);
        Assert.Equal("ToolPresentation", presentation.Subject);
        Assert.Equal(["src"], presentation.Paths);
        Assert.Null(presentation.Outcome);
    }

    [Fact]
    public void Accumulator_RetainsFixedWindowsForArbitrarilyLargeOutput()
    {
        var accumulator = new BoundedToolOutputAccumulator();
        for (var index = 0; index < 10_000; index++)
        {
            accumulator.Append(string.Create(
                CultureInfo.InvariantCulture,
                $"line {index} {new string('x', 1_024)}\n"));
        }

        var snapshot = accumulator.Export();
        var presentation = new AppServerControlToolPresentation
        {
            Category = "command",
            Label = "Ran command"
        };
        accumulator.ApplyTo(presentation, "completed");

        Assert.Equal(BoundedToolOutputAccumulator.HeadLineLimit, snapshot.HeadLines.Count);
        Assert.Equal(BoundedToolOutputAccumulator.TailLineLimit, snapshot.TailLines.Count);
        Assert.All(snapshot.HeadLines, line => Assert.True(line.Length <= BoundedToolOutputAccumulator.MaxLineChars + 1));
        Assert.All(snapshot.TailLines, line => Assert.True(line.Length <= BoundedToolOutputAccumulator.MaxLineChars + 1));
        Assert.True((presentation.Evidence?.Length ?? 0) < 4_096);
        Assert.Equal(10_000, presentation.TotalLineCount);
        Assert.True(presentation.OmittedLineCount >= 9_993);
    }

    [Fact]
    public void Accumulator_DoesNotAllocatePerDiscardedLine()
    {
        var accumulator = new BoundedToolOutputAccumulator();
        const string line = "a reusable provider output line\n";
        for (var index = 0; index < 20; index++)
        {
            accumulator.Append(line);
        }

        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var index = 0; index < 10_000; index++)
        {
            accumulator.Append(line);
        }
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        Assert.InRange(allocated, 0, 64 * 1_024);
    }

    [Fact]
    public void Accumulator_StripsSplitAnsiAndOscControlSequences()
    {
        var accumulator = new BoundedToolOutputAccumulator();
        accumulator.Append("\u001b[31");
        accumulator.Append("mred\u001b[0m\n\u001b]0;secret title");
        accumulator.Append("\aresult\u0001\n");
        var presentation = new AppServerControlToolPresentation
        {
            Category = "command",
            Label = "Ran command"
        };

        accumulator.ApplyTo(presentation, "completed");

        var evidence = Assert.IsType<string>(presentation.Evidence);
        Assert.Equal("red\nresult", evidence);
        Assert.DoesNotContain('\u001b', evidence);
        Assert.DoesNotContain("secret title", evidence, StringComparison.Ordinal);
    }

    [Fact]
    public void Accumulator_RestoresBoundedStreamingState()
    {
        var first = new BoundedToolOutputAccumulator();
        first.Append("one\ntw");
        var second = new BoundedToolOutputAccumulator();
        second.Restore(first.Export());
        second.Append("o\nthree");
        var presentation = new AppServerControlToolPresentation
        {
            Category = "command",
            Label = "Ran command"
        };

        second.ApplyTo(presentation, "completed");

        Assert.Equal("one\ntwo\nthree", presentation.Evidence);
        Assert.Equal(3, presentation.TotalLineCount);
    }
}
