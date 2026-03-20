using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class PathSensitiveEnvironmentCollection
{
    public const string Name = "PathSensitiveEnvironment";
}
