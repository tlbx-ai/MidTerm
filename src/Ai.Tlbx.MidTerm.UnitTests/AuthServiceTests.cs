using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Services.Security;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.Extensions.Time.Testing;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class AuthServiceTests : IDisposable
{
    private readonly string _tempDir;
    private readonly SettingsService _settingsService;
    private readonly FakeTimeProvider _timeProvider;
    private readonly ApiKeyService _apiKeyService;
    private readonly AuthService _authService;

    public AuthServiceTests()
    {
        // SettingsService creates WindowsSecretStorage (DPAPI) when WINDOWS is defined,
        // which fails at runtime on non-Windows platforms. Skip setup there.
        if (!OperatingSystem.IsWindows())
        {
            _tempDir = string.Empty;
            _settingsService = null!;
            _timeProvider = null!;
            _apiKeyService = null!;
            _authService = null!;
            return;
        }

        _tempDir = Path.Combine(Path.GetTempPath(), $"midterm_test_{Guid.NewGuid():N}");
        Directory.CreateDirectory(_tempDir);
        _settingsService = new SettingsService(_tempDir);
        _timeProvider = new FakeTimeProvider(DateTimeOffset.UtcNow);
        _apiKeyService = new ApiKeyService(_settingsService, _timeProvider);
        _authService = new AuthService(_settingsService, _apiKeyService, _timeProvider);
    }

    private static bool IsWindows => OperatingSystem.IsWindows();

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_tempDir))
            {
                Directory.Delete(_tempDir, recursive: true);
            }
        }
        catch
        {
            // Best effort cleanup
        }

        GC.SuppressFinalize(this);
    }

    [Fact]
    public void HashPassword_VerifyPassword_RoundTrip()
    {
        if (!IsWindows) return;
        var password = "MySecurePassword123!";

        var hash = _authService.HashPassword(password);
        var result = _authService.VerifyPassword(password, hash);

        Assert.True(result);
    }

    [Fact]
    public void HashPassword_ProducesDifferentHashesForSamePassword()
    {
        if (!IsWindows) return;
        var password = "TestPassword";

        var hash1 = _authService.HashPassword(password);
        var hash2 = _authService.HashPassword(password);

        Assert.NotEqual(hash1, hash2);
    }

    [Fact]
    public void VerifyPassword_WrongPassword_ReturnsFalse()
    {
        if (!IsWindows) return;
        var hash = _authService.HashPassword("CorrectPassword");

        var result = _authService.VerifyPassword("WrongPassword", hash);

        Assert.False(result);
    }

    [Fact]
    public void VerifyPassword_CorruptedHash_ReturnsFalse()
    {
        if (!IsWindows) return;
        var corruptedHash = "$PBKDF2$100000$invalidbase64$alsonotvalid";

        var result = _authService.VerifyPassword("AnyPassword", corruptedHash);

        Assert.False(result);
    }

    [Fact]
    public void VerifyPassword_MalformedHash_ReturnsFalse()
    {
        if (!IsWindows) return;
        var malformedHash = "notavalidhash";

        var result = _authService.VerifyPassword("AnyPassword", malformedHash);

        Assert.False(result);
    }

    [Fact]
    public void VerifyPassword_EmptyPassword_ReturnsFalse()
    {
        if (!IsWindows) return;
        var hash = _authService.HashPassword("SomePassword");

        var result = _authService.VerifyPassword("", hash);

        Assert.False(result);
    }

    [Fact]
    public void VerifyPassword_NullHash_ReturnsFalse()
    {
        if (!IsWindows) return;
        var result = _authService.VerifyPassword("AnyPassword", null);

        Assert.False(result);
    }

    [Fact]
    public void VerifyPassword_EmptyHash_ReturnsFalse()
    {
        if (!IsWindows) return;
        var result = _authService.VerifyPassword("AnyPassword", "");

        Assert.False(result);
    }

    [Fact]
    public void RateLimit_FourFailures_NotLocked()
    {
        if (!IsWindows) return;
        var ip = "192.168.1.1";

        for (var i = 0; i < 4; i++)
        {
            _authService.RecordFailedAttempt(ip);
        }

        Assert.False(_authService.IsRateLimited(ip));
    }

    [Fact]
    public void RateLimit_FiveFailures_30SecondLockout()
    {
        if (!IsWindows) return;
        var ip = "192.168.1.2";

        for (var i = 0; i < 5; i++)
        {
            _authService.RecordFailedAttempt(ip);
        }

        Assert.True(_authService.IsRateLimited(ip));

        var remaining = _authService.GetRemainingLockout(ip);
        Assert.NotNull(remaining);
        Assert.True(remaining.Value.TotalSeconds <= 30);
        Assert.True(remaining.Value.TotalSeconds > 0);
    }

    [Fact]
    public void RateLimit_TenFailures_5MinuteLockout()
    {
        if (!IsWindows) return;
        var ip = "192.168.1.3";

        for (var i = 0; i < 10; i++)
        {
            _authService.RecordFailedAttempt(ip);
        }

        Assert.True(_authService.IsRateLimited(ip));

        var remaining = _authService.GetRemainingLockout(ip);
        Assert.NotNull(remaining);
        Assert.True(remaining.Value.TotalMinutes <= 5);
        Assert.True(remaining.Value.TotalMinutes > 0.5);
    }

    [Fact]
    public void RateLimit_ResetAttempts_ClearsLockout()
    {
        if (!IsWindows) return;
        var ip = "192.168.1.4";

        for (var i = 0; i < 5; i++)
        {
            _authService.RecordFailedAttempt(ip);
        }
        Assert.True(_authService.IsRateLimited(ip));

        _authService.ResetAttempts(ip);

        Assert.False(_authService.IsRateLimited(ip));
        Assert.Null(_authService.GetRemainingLockout(ip));
    }

    [Fact]
    public void RateLimit_LockoutExpires_AfterTime()
    {
        if (!IsWindows) return;
        var ip = "192.168.1.5";

        for (var i = 0; i < 5; i++)
        {
            _authService.RecordFailedAttempt(ip);
        }
        Assert.True(_authService.IsRateLimited(ip));

        _timeProvider.Advance(TimeSpan.FromSeconds(31));

        Assert.False(_authService.IsRateLimited(ip));
    }

    [Fact]
    public void RateLimit_5MinLockoutExpires_AfterTime()
    {
        if (!IsWindows) return;
        var ip = "192.168.1.6";

        for (var i = 0; i < 10; i++)
        {
            _authService.RecordFailedAttempt(ip);
        }
        Assert.True(_authService.IsRateLimited(ip));

        _timeProvider.Advance(TimeSpan.FromMinutes(5) + TimeSpan.FromSeconds(1));

        Assert.False(_authService.IsRateLimited(ip));
    }

    [Fact]
    public void SessionToken_ValidWithin72Hours()
    {
        if (!IsWindows) return;
        var token = _authService.CreateSessionToken();

        _timeProvider.Advance(TimeSpan.FromHours(71));

        Assert.True(_authService.ValidateSessionToken(token));
    }

    [Fact]
    public void SessionToken_InvalidAfter72Hours()
    {
        if (!IsWindows) return;
        var token = _authService.CreateSessionToken();

        _timeProvider.Advance(TimeSpan.FromHours(73));

        Assert.False(_authService.ValidateSessionToken(token));
    }

    [Fact]
    public void SessionToken_TamperedSignature_Invalid()
    {
        if (!IsWindows) return;
        var token = _authService.CreateSessionToken();
        var parts = token.Split(':');
        var tamperedToken = $"{parts[0]}:tampered_signature";

        Assert.False(_authService.ValidateSessionToken(tamperedToken));
    }

    [Fact]
    public void SessionToken_TamperedTimestamp_Invalid()
    {
        if (!IsWindows) return;
        var token = _authService.CreateSessionToken();
        var parts = token.Split(':');
        var tamperedToken = $"9999999999:{parts[1]}";

        Assert.False(_authService.ValidateSessionToken(tamperedToken));
    }

    [Fact]
    public void SessionToken_NullToken_Invalid()
    {
        if (!IsWindows) return;
        Assert.False(_authService.ValidateSessionToken(null));
    }

    [Fact]
    public void SessionToken_EmptyToken_Invalid()
    {
        if (!IsWindows) return;
        Assert.False(_authService.ValidateSessionToken(""));
    }

    [Fact]
    public void SessionToken_MalformedToken_Invalid()
    {
        if (!IsWindows) return;
        Assert.False(_authService.ValidateSessionToken("notavalidtoken"));
    }

    [Fact]
    public void AuthenticateRequest_BearerApiKey_ReturnsApiKey()
    {
        if (!IsWindows) return;

        var settings = _settingsService.Load();
        settings.AuthenticationEnabled = true;
        settings.PasswordHash = AuthService.HashPasswordStatic("Secret123");
        _settingsService.Save(settings);

        var created = _apiKeyService.CreateApiKey("Primary Agent");
        var context = new DefaultHttpContext();
        context.Request.Headers.Authorization = $"Bearer {created.Token}";

        var result = _authService.AuthenticateRequest(context.Request);

        Assert.Equal(RequestAuthMethod.ApiKey, result);
    }

    [Fact]
    public void AuthenticateRequest_XApiKeyHeader_ReturnsApiKey()
    {
        if (!IsWindows) return;

        var settings = _settingsService.Load();
        settings.AuthenticationEnabled = true;
        settings.PasswordHash = AuthService.HashPasswordStatic("Secret123");
        _settingsService.Save(settings);

        var created = _apiKeyService.CreateApiKey("Secondary Agent");
        var context = new DefaultHttpContext();
        context.Request.Headers["X-API-Key"] = created.Token;

        var result = _authService.AuthenticateRequest(context.Request);

        Assert.Equal(RequestAuthMethod.ApiKey, result);
    }
}
