using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Voice.Services;
using Ai.Tlbx.MidTerm.Voice.WebSockets;

namespace Ai.Tlbx.MidTerm.Voice;

public class Program
{
    public static async Task Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        builder.Services.AddSingleton<VoiceSessionService>();
        builder.Services.AddSingleton<VoiceWebSocketHandler>();

        var app = builder.Build();

        var logDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".MidTerm",
            "logs");
        Directory.CreateDirectory(logDirectory);
        Log.Initialize("mtvoice", logDirectory, Common.Logging.LogSeverity.Info);

        app.UseWebSockets();

        var voiceHandler = app.Services.GetRequiredService<VoiceWebSocketHandler>();

        app.Use(async (context, next) =>
        {
            if (context.Request.Path == "/voice" && context.WebSockets.IsWebSocketRequest)
            {
                await voiceHandler.HandleAsync(context);
                return;
            }

            await next(context);
        });

        app.MapGet("/", () => "MidTerm.Voice Server - Connect via WebSocket at /voice");

        app.MapGet("/health", () => new
        {
            Status = "healthy",
            Version = "0.1.0"
        });

        var port = builder.Configuration.GetValue("Port", 3000);
        var url = $"http://0.0.0.0:{port}";

        Log.Info(() => $"MidTerm.Voice server starting on {url}");
        Console.WriteLine($"MidTerm.Voice server listening on {url}");
        Console.WriteLine("WebSocket endpoint: /voice");

        app.Urls.Add(url);
        await app.RunAsync();
    }
}
