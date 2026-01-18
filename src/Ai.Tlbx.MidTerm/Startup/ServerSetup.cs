using System.Reflection;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Ai.Tlbx.MidTerm.Common.Shells;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;

namespace Ai.Tlbx.MidTerm.Startup;

public static class ServerSetup
{
    public static X509Certificate2? LoadedCertificate { get; private set; }
    public static bool IsFallbackCertificate { get; private set; }

    public static WebApplicationBuilder CreateBuilder(string[] args, Action<string, bool>? writeEventLog = null)
    {
        writeEventLog?.Invoke("CreateBuilder: Starting", false);

        var builder = WebApplication.CreateSlimBuilder(args);

#if WINDOWS
        writeEventLog?.Invoke("CreateBuilder: Configuring Windows service", false);
        builder.Host.UseWindowsService();
#endif

        writeEventLog?.Invoke("CreateBuilder: Loading settings", false);

        var settingsService = new SettingsService();
        var settings = settingsService.Load();

        writeEventLog?.Invoke($"CreateBuilder: Settings loaded - CertPath={settings.CertificatePath}, KeyProtection={settings.KeyProtection}, IsService={settingsService.IsRunningAsService}", false);

        builder.WebHost.UseKestrelHttpsConfiguration();

        writeEventLog?.Invoke("CreateBuilder: Configuring Kestrel", false);

        builder.WebHost.ConfigureKestrel(options =>
        {
            options.AddServerHeader = false;

            writeEventLog?.Invoke("ConfigureKestrel: Loading certificate", false);

            var cert = CertificateSetup.LoadOrGenerateCertificate(settings, settingsService, writeEventLog);
            if (cert is null)
            {
                writeEventLog?.Invoke("ConfigureKestrel: Certificate load failed, using fallback", true);
                Console.ForegroundColor = ConsoleColor.Yellow;
                Console.WriteLine("Warning: Using emergency fallback certificate.");
                Console.WriteLine("         Run 'mt --generate-cert' to create a proper certificate.");
                Console.ResetColor();
                cert = CertificateGenerator.GenerateSelfSigned(["localhost"], ["127.0.0.1"], useEcdsa: true);
                IsFallbackCertificate = true;
            }

            writeEventLog?.Invoke($"ConfigureKestrel: Certificate loaded - Subject={cert.Subject}, HasPrivateKey={cert.HasPrivateKey}", false);

            LoadedCertificate = cert;

            options.ConfigureHttpsDefaults(httpsOptions =>
            {
                httpsOptions.ServerCertificate = cert;

                httpsOptions.SslProtocols = System.Security.Authentication.SslProtocols.Tls12
                                            | System.Security.Authentication.SslProtocols.Tls13;

                if (!OperatingSystem.IsWindows())
                {
                    httpsOptions.OnAuthenticate = (context, sslOptions) =>
                    {
#pragma warning disable CA1416
                        sslOptions.CipherSuitesPolicy = new System.Net.Security.CipherSuitesPolicy(
                        [
                            System.Net.Security.TlsCipherSuite.TLS_AES_256_GCM_SHA384,
                            System.Net.Security.TlsCipherSuite.TLS_AES_128_GCM_SHA256,
                            System.Net.Security.TlsCipherSuite.TLS_CHACHA20_POLY1305_SHA256,
                            System.Net.Security.TlsCipherSuite.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
                            System.Net.Security.TlsCipherSuite.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
                            System.Net.Security.TlsCipherSuite.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
                            System.Net.Security.TlsCipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
                            System.Net.Security.TlsCipherSuite.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
                            System.Net.Security.TlsCipherSuite.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
                        ]);
#pragma warning restore CA1416
                    };
                }
            });
        });
        builder.Logging.SetMinimumLevel(Microsoft.Extensions.Logging.LogLevel.Warning);

        builder.Services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
        });

        builder.Services.AddSingleton<ShellRegistry>();
        builder.Services.AddSingleton<SettingsService>();
        builder.Services.AddSingleton<UpdateService>();
        builder.Services.AddSingleton<AuthService>();
        builder.Services.AddSingleton<TempCleanupService>();
        builder.Services.AddSingleton<CertificateInfoService>();

        return builder;
    }

    public static void ConfigureStaticFiles(WebApplication app)
    {
#if DEBUG
        var wwwrootPath = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "wwwroot");
        IFileProvider fileProvider = Directory.Exists(wwwrootPath)
            ? new PhysicalFileProvider(Path.GetFullPath(wwwrootPath))
            : new EmbeddedWebRootFileProvider(Assembly.GetExecutingAssembly(), "Ai.Tlbx.MidTerm");
        var useCompressedFiles = false;
#else
        IFileProvider fileProvider = new EmbeddedWebRootFileProvider(
            Assembly.GetExecutingAssembly(),
            "Ai.Tlbx.MidTerm");
        var useCompressedFiles = true;
#endif

        // Rewrite clean URLs and consolidate icon requests
        app.Use(async (context, next) =>
        {
            var path = context.Request.Path.Value;
            if (path == "/trust" || path == "/login")
            {
                context.Request.Path = path + ".html";
            }
            else if (path == "/apple-touch-icon.png" ||
                     path == "/favicon-16x16.png" ||
                     path == "/favicon-32x32.png")
            {
                context.Request.Path = "/android-chrome-192x192.png";
            }
            await next();
        });

        app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = fileProvider });

        // In release builds, serve pre-compressed .br files for text assets
        if (useCompressedFiles)
        {
            app.UseMiddleware<CompressedStaticFilesMiddleware>(fileProvider);
        }

        var contentTypeProvider = new FileExtensionContentTypeProvider();
        contentTypeProvider.Mappings[".ico"] = "image/x-icon";
        contentTypeProvider.Mappings[".webmanifest"] = "application/manifest+json";
        contentTypeProvider.Mappings[".br"] = "application/octet-stream";
        contentTypeProvider.Mappings[".woff"] = "font/woff";
        contentTypeProvider.Mappings[".woff2"] = "font/woff2";
        contentTypeProvider.Mappings[".ttf"] = "font/ttf";
        contentTypeProvider.Mappings[".eot"] = "application/vnd.ms-fontobject";

        app.UseStaticFiles(new StaticFileOptions
        {
            FileProvider = fileProvider,
            ContentTypeProvider = contentTypeProvider,
            OnPrepareResponse = ctx =>
            {
                var path = ctx.Context.Request.Path.Value ?? "";
                var isFont = path.EndsWith(".woff2", StringComparison.OrdinalIgnoreCase)
                          || path.EndsWith(".woff", StringComparison.OrdinalIgnoreCase)
                          || path.EndsWith(".ttf", StringComparison.OrdinalIgnoreCase);

                if (isFont)
                {
                    ctx.Context.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
                }
                else
                {
                    ctx.Context.Response.Headers.Remove("ETag");
                    ctx.Context.Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
                    ctx.Context.Response.Headers.Pragma = "no-cache";
                }
            }
        });

        app.UseWebSockets();
    }

    public static void ConfigureMiddleware(WebApplication app, SettingsService settingsService, AuthService authService)
    {
        // HSTS middleware - always enabled (HTTPS only)
        app.Use(async (context, next) =>
        {
            context.Response.Headers.StrictTransportSecurity = "max-age=31536000; includeSubDomains";
            await next();
        });

        // Auth middleware must run BEFORE static files so unauthenticated users get redirected to login
        AuthEndpoints.ConfigureAuthMiddleware(app, settingsService, authService);

        // Security headers middleware
        app.Use(async (context, next) =>
        {
            var headers = context.Response.Headers;
            headers["X-Frame-Options"] = "DENY";
            headers["X-Content-Type-Options"] = "nosniff";
            headers["Referrer-Policy"] = "strict-origin-when-cross-origin";

            // Content Security Policy - strict but allows xterm.js inline styles
            var csp = "default-src 'self'; " +
                      "script-src 'self'; " +
                      "style-src 'self' 'unsafe-inline'; " +
                      "img-src 'self' data:; " +
                      "font-src 'self' data:; " +
                      "connect-src 'self' ws: wss: https://api.github.com; " +
                      "frame-ancestors 'none'";
            headers.ContentSecurityPolicy = csp;

            await next();
        });

        ConfigureStaticFiles(app);
    }
}
