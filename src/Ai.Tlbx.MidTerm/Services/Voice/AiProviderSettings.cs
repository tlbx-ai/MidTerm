using System.Text.Json.Nodes;
using Ai.Tlbx.Inference;
using Ai.Tlbx.Inference.Configuration;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services.Voice;

/// <summary>Provider credentials belong to this installation, never to bootstrap or browser storage.</summary>
public sealed class AiProviderSettings(SettingsService settings)
{
    private readonly Lock _gate = new();
    internal static readonly string[] Providers = ["openai", "google", "anthropic", "xai"];
    internal static readonly AiModel[] WorkerModels = [AiModel.Gpt61Sol, AiModel.Gpt6Luna,
        AiModel.ClaudeSonnet46, AiModel.Gemini35Flash, AiModel.Grok41Fast];
    private const string ModelKey = "tlbx.ai.worker_model";

    public string? GetKey(string provider)
    {
        if (!Providers.Contains(provider)) throw new ArgumentException("Unknown AI provider.");
        lock (_gate) return settings.SecretStorage.GetSecret("tlbx.ai." + provider);
    }

    public void SetKey(string provider, string? key)
    {
        if (!Providers.Contains(provider)) throw new ArgumentException("Unknown AI provider.");
        if (key?.Length > 8192 || key?.Any(char.IsControl) == true) throw new ArgumentException("Invalid API key.");
        lock (_gate)
        {
            if (string.IsNullOrWhiteSpace(key)) settings.SecretStorage.DeleteSecret("tlbx.ai." + provider);
            else settings.SecretStorage.SetSecret("tlbx.ai." + provider, key.Trim());
        }
    }

    public AiModel WorkerModel
    {
        get { lock (_gate) return Enum.TryParse<AiModel>(settings.SecretStorage.GetSecret(ModelKey), out var model)
                && WorkerModels.Contains(model) ? model : AiModel.Gpt61Sol; }
        set { if (!WorkerModels.Contains(value)) throw new ArgumentException("Unsupported worker model.");
            lock (_gate) settings.SecretStorage.SetSecret(ModelKey, value.ToString()); }
    }

    internal static string ProviderFor(AiModel model) => model.GetProvider() switch
    {
        ProviderType.OpenAi => "openai", ProviderType.Google => "google",
        ProviderType.Anthropic => "anthropic", ProviderType.Xai => "xai",
        _ => throw new ArgumentException("Unsupported provider.")
    };

    public JsonObject Status() => new()
    {
        ["providers"] = new JsonArray(Providers.Select(p => (JsonNode)new JsonObject {
            ["id"] = p, ["configured"] = !string.IsNullOrEmpty(GetKey(p)) }).ToArray()),
        ["workerModel"] = WorkerModel.ToString(), ["voiceModel"] = "gpt-live-1",
        ["workerModels"] = new JsonArray(WorkerModels.Select(m => (JsonNode)new JsonObject {
            ["id"] = m.ToString(), ["name"] = m.ToDisplayName(), ["provider"] = ProviderFor(m) }).ToArray())
    };

    public AiInferenceClient CreateClient(HttpClient http)
    {
        var options = new AiInferenceOptions();
        if (GetKey("openai") is { } openai) options.AddOpenAi(openai);
        if (GetKey("google") is { } google) options.AddGoogle(google);
        if (GetKey("anthropic") is { } anthropic) options.AddAnthropic(anthropic);
        if (GetKey("xai") is { } xai) options.AddXai(xai);
        return new AiInferenceClient(http, options);
    }
}
