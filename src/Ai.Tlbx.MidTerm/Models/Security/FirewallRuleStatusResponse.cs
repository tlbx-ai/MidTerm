namespace Ai.Tlbx.MidTerm.Models.Security;

public sealed class FirewallRuleStatusResponse
{
    public bool Supported { get; init; }
    public bool CanManage { get; init; }
    public bool RulePresent { get; init; }
    public bool RuleEnabled { get; init; }
    public bool MatchesCurrentPort { get; init; }
    public bool MatchesCurrentProgram { get; init; }
    public int Port { get; init; }
    public string BindAddress { get; init; } = "";
    public bool LoopbackOnly { get; init; }
    public string RuleName { get; init; } = "";
    public string? RuleLocalPort { get; init; }
    public string? RuleProgramPath { get; init; }
}
