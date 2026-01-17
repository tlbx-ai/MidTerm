namespace Ai.Tlbx.MidTerm.Voice.Services;

/// <summary>
/// Provides configuration and settings for voice sessions.
/// </summary>
public sealed class VoiceSessionService
{
    private readonly IConfiguration _configuration;

    public VoiceSessionService(IConfiguration configuration)
    {
        _configuration = configuration;
    }

    public string? GetOpenAiApiKey()
    {
        return _configuration["OpenAI:ApiKey"]
            ?? Environment.GetEnvironmentVariable("OPENAI_API_KEY");
    }

    public string GetSystemPrompt()
    {
        return _configuration["Voice:SystemPrompt"]
            ?? """
            You are a helpful voice assistant for MidTerm, a terminal multiplexer.
            You can help users with terminal operations, answer questions, and provide assistance.
            Keep responses concise and conversational since this is a voice interface.
            """;
    }

    public string GetMidTermServerUrl()
    {
        return _configuration["Voice:MidTermServerUrl"]
            ?? "https://localhost:2000";
    }
}
