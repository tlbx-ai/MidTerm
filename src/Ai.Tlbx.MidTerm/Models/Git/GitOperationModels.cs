using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Models.Git;

public sealed class GitOperationRequest
{
    public string SessionId { get; set; } = "";
    public string RepoRoot { get; set; } = "";
    public string OperationId { get; set; } = "";
    public string Action { get; set; } = "";
    public string[] Paths { get; set; } = [];
    public bool All { get; set; }
    public string? Message { get; set; }
    public string? ExpectedIndexVersion { get; set; }
    public string? ExpectedHead { get; set; }
    public string? ExpectedPatchVersion { get; set; }
    public int[] SelectedHunks { get; set; } = [];
    public GitSelectedLine[] SelectedLines { get; set; } = [];
}

public sealed class GitSelectedLine
{
    public int Hunk { get; set; }
    public int Line { get; set; }
}

public sealed class GitOperationResponse
{
    public string OperationId { get; set; } = "";
    public string RepoRoot { get; set; } = "";
    public string Action { get; set; } = "";
    public string State { get; set; } = "";
    public string? ErrorCode { get; set; }
    public string? Detail { get; set; }
    public string? CommitHash { get; set; }
    public GitStatusResponse? Status { get; set; }
    [JsonIgnore] public int StatusCode { get; set; } = 200;
}

public sealed class GitOperationReceipt
{
    public string Fingerprint { get; set; } = "";
    public int StatusCode { get; set; } = 200;
    public GitOperationResponse Result { get; set; } = new();
}

internal sealed class GitOperationException(int statusCode, string code, string detail) : Exception(detail)
{
    internal int StatusCode { get; } = statusCode;
    internal string Code { get; } = code;
}
