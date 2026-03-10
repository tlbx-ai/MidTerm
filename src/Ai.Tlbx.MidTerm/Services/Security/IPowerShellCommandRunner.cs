namespace Ai.Tlbx.MidTerm.Services.Security;

public interface IPowerShellCommandRunner
{
    PowerShellCommandResult Run(string script);
}
