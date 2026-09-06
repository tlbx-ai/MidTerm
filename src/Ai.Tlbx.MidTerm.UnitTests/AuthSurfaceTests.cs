using System.Text.RegularExpressions;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Services.Browser;
using Ai.Tlbx.MidTerm.Services.Security;
using Ai.Tlbx.MidTerm.Services.Share;
using Ai.Tlbx.MidTerm.Settings;
using Ai.Tlbx.MidTerm.Startup;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class AuthSurfaceTests
{
    [Fact]
    public async Task RegisteredApiSurface_RequiresCredentialsBeforeDispatch()
    {
        if (!OperatingSystem.IsWindows()) return;
        var directory = Path.Combine(Path.GetTempPath(), $"tlbx-auth-surface-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            var settings = new SettingsService(directory);
            var configuration = settings.Load();
            configuration.PasswordHash = "configured";
            configuration.AuthenticationEnabled = false; // Legacy settings cannot disable access control.
            settings.Save(configuration);
            var keys = new ApiKeyService(settings);
            var auth = new AuthService(settings, keys);
            var shares = new ShareGrantService(settings);
            await using var app = WebApplication.CreateBuilder().Build();
            AuthMiddleware.ConfigureAuthMiddleware(app, settings, auth, shares,
                new BrowserPreviewOriginService(2000, 2001, true), new BrowserPreviewRegistry());
            app.Run(context =>
            {
                context.Items["dispatched"] = true;
                return Task.CompletedTask;
            });
            var pipeline = ((IApplicationBuilder)app).Build();
            var sourceRoot = FindSourceRoot();
            using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(sourceRoot, "openapi", "openapi.json")));
            var routes = ReadOpenApiRoutes(document)
                .Concat(ReadSourceRoutes(sourceRoot))
                .Concat(new (string Method, string Path)[] { ("GET", "/ws/state"), ("GET", "/ws/mux"), ("GET", "/ws/settings"),
                    ("GET", "/ws/git"), ("GET", "/ws/browser"), ("GET", "/ws/share/state"),
                    ("GET", "/ws/share/mux"), ("POST", "/api/auth/future"), ("POST", "/api/shutdown") })
                .Distinct().ToArray();
            Assert.True(routes.Length > 200, "The test must cover the complete generated API inventory.");
            var cookie = $"{AuthService.SessionCookieName}={auth.CreateSessionToken()}";
            foreach (var route in routes)
            {
                var context = Context(route.Method, route.Path);
                await pipeline(context);
                var isPublic = route.Method == "POST" && route.Path is "/api/auth/login" or "/api/share/claim"
                    || route.Method is "GET" or "HEAD" && route.Path is "/api/bootstrap/login" or "/api/certificate/info"
                        or "/api/certificate/download/pem" or "/api/certificate/download/crt" or "/api/certificate/download/mobileconfig";
                Assert.True(context.Response.StatusCode == (isPublic ? 200 : 401),
                    $"Unexpected anonymous status: {route.Method} {route.Path}");
                Assert.Equal(isPublic, context.Items.ContainsKey("dispatched"));
                if (isPublic || route.Path.StartsWith("/api/share/", StringComparison.Ordinal)
                    || route.Path.StartsWith("/ws/share/", StringComparison.Ordinal)) continue;
                context = Context(route.Method, route.Path);
                context.Request.Headers.Cookie = cookie;
                await pipeline(context);
                Assert.True(context.Items.ContainsKey("dispatched"), $"Valid owner credential rejected: {route}");
            }

            foreach (var credential in new[] { "invalid", keys.CreateApiKey("surface-test").Token })
            {
                var context = Context("GET", "/api/sessions");
                context.Request.Headers.Authorization = $"Bearer {credential}";
                await pipeline(context);
                Assert.Equal(credential != "invalid", context.Items.ContainsKey("dispatched"));
            }

            var crossSite = Context("POST", "/api/auth/logout");
            crossSite.Request.Headers.Cookie = cookie;
            crossSite.Request.Headers.Origin = "https://attacker.invalid";
            await pipeline(crossSite);
            Assert.Equal(403, crossSite.Response.StatusCode);
            Assert.False(crossSite.Items.ContainsKey("dispatched"));

            configuration = settings.Load();
            configuration.PasswordHash = null;
            settings.Save(configuration);
            var locked = Context("POST", "/api/shutdown");
            locked.Request.Headers.Cookie = cookie;
            await pipeline(locked);
            Assert.Equal(503, locked.Response.StatusCode);
            Assert.False(locked.Items.ContainsKey("dispatched"));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static DefaultHttpContext Context(string method, string path)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = path;
        context.Request.Scheme = "https";
        context.Request.Host = new HostString("localhost", 2000);
        context.Connection.LocalPort = 2000;
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static IEnumerable<(string Method, string Path)> ReadOpenApiRoutes(JsonDocument document)
    {
        using var paths = document.RootElement.GetProperty("paths").EnumerateObject();
        foreach (var path in paths)
        {
            using var methods = path.Value.EnumerateObject();
            foreach (var method in methods)
                if (method.Name is "get" or "post" or "put" or "patch" or "delete" or "head" or "options")
                    yield return (method.Name.ToUpperInvariant(), path.Name);
        }
    }

    private static IEnumerable<(string Method, string Path)> ReadSourceRoutes(string sourceRoot)
    {
        foreach (var folder in new[] { "Startup", "Services" })
        foreach (var file in Directory.EnumerateFiles(Path.Combine(sourceRoot, folder), "*.cs", SearchOption.AllDirectories))
        foreach (Match match in Regex.Matches(File.ReadAllText(file), """\.Map(Get|Post|Put|Patch|Delete)\(\s*"(/(?:api|ws)/[^"\r\n]+)""", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1)))
            yield return (match.Groups[1].Value.ToUpperInvariant(), match.Groups[2].Value);
    }

    private static string FindSourceRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "Ai.Tlbx.MidTerm");
            if (File.Exists(Path.Combine(candidate, "openapi", "openapi.json"))) return candidate;
        }
        throw new DirectoryNotFoundException("Cannot locate the actual OpenAPI endpoint inventory.");
    }
}
