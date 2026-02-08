using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Provides authentication services including password hashing, session token management, and rate limiting.
/// Uses PBKDF2 (100K iterations, SHA256) for password hashing and HMAC-SHA256 for session tokens.
/// </summary>
public sealed class AuthService
{
    public const string SessionCookieName = "mm-session";

    private const int Iterations = 100_000;
    private const int SaltSize = 32;
    private const int HashSize = 32;
    private const int SessionTokenValidityHours = 24 * 3; // 3 days (sliding window refresh on activity)

    private readonly SettingsService _settingsService;
    private readonly TimeProvider _timeProvider;
    private readonly ConcurrentDictionary<string, RateLimitEntry> _rateLimits = new();

    public AuthService(SettingsService settingsService, TimeProvider? timeProvider = null)
    {
        _settingsService = settingsService;
        _timeProvider = timeProvider ?? TimeProvider.System;

        var settings = _settingsService.Load();
        var dirty = false;

        if (string.IsNullOrEmpty(settings.SessionSecret))
        {
            settings.SessionSecret = GenerateSessionSecret();
            dirty = true;
        }

        if (settings.PasswordHash is not null && settings.PasswordHash.StartsWith("__PENDING__:"))
        {
            var pendingPassword = settings.PasswordHash["__PENDING__:".Length..];
            settings.PasswordHash = HashPassword(pendingPassword);
            dirty = true;
        }

        if (dirty)
        {
            _settingsService.Save(settings);
        }
    }

    /// <summary>
    /// Hashes a password using PBKDF2 with a random salt.
    /// </summary>
    public string HashPassword(string password) => HashPasswordStatic(password);

    /// <summary>
    /// Static version for CLI use without needing full AuthService initialization.
    /// </summary>
    public static string HashPasswordStatic(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltSize);
        var hash = Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(password),
            salt,
            Iterations,
            HashAlgorithmName.SHA256,
            HashSize);

        return $"$PBKDF2${Iterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    public bool VerifyPassword(string password, string? storedHash)
    {
        if (string.IsNullOrEmpty(storedHash) || string.IsNullOrEmpty(password))
        {
            return false;
        }

        var parts = storedHash.Split('$');
        if (parts.Length != 5 || parts[1] != "PBKDF2")
        {
            return false;
        }

        if (!int.TryParse(parts[2], out var iterations))
        {
            return false;
        }

        byte[] salt;
        byte[] expectedHash;
        try
        {
            salt = Convert.FromBase64String(parts[3]);
            expectedHash = Convert.FromBase64String(parts[4]);
        }
        catch
        {
            return false;
        }

        var actualHash = Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(password),
            salt,
            iterations,
            HashAlgorithmName.SHA256,
            expectedHash.Length);

        return CryptographicOperations.FixedTimeEquals(actualHash, expectedHash);
    }

    /// <summary>
    /// Creates a new HMAC-signed session token valid for 3 weeks.
    /// </summary>
    public string CreateSessionToken()
    {
        var settings = _settingsService.Load();
        EnsureSessionSecret(settings);

        var timestamp = _timeProvider.GetUtcNow().ToUnixTimeSeconds();
        var signature = ComputeHmac(timestamp.ToString(), settings.SessionSecret!);

        return $"{timestamp}:{signature}";
    }

    /// <summary>
    /// Validates a session token's signature and expiration.
    /// </summary>
    public bool ValidateSessionToken(string? token)
    {
        if (string.IsNullOrEmpty(token))
        {
            return false;
        }

        var parts = token.Split(':');
        if (parts.Length != 2 || !long.TryParse(parts[0], out var timestamp))
        {
            return false;
        }

        var tokenTime = DateTimeOffset.FromUnixTimeSeconds(timestamp);
        if (_timeProvider.GetUtcNow() - tokenTime > TimeSpan.FromHours(SessionTokenValidityHours))
        {
            return false;
        }

        var settings = _settingsService.Load();
        if (string.IsNullOrEmpty(settings.SessionSecret))
        {
            return false;
        }

        var expectedSignature = ComputeHmac(timestamp.ToString(), settings.SessionSecret);
        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(parts[1]),
            Encoding.UTF8.GetBytes(expectedSignature));
    }

    /// <summary>
    /// Checks if an IP address is currently rate-limited.
    /// </summary>
    public bool IsRateLimited(string ip)
    {
        if (!_rateLimits.TryGetValue(ip, out var entry))
        {
            return false;
        }

        if (_timeProvider.GetUtcNow().DateTime > entry.BlockedUntil)
        {
            _rateLimits.TryRemove(ip, out _);
            return false;
        }

        return true;
    }

    /// <summary>
    /// Records a failed login attempt. After 5 failures: 30s lockout. After 10: 5min lockout.
    /// </summary>
    public void RecordFailedAttempt(string ip)
    {
        var entry = _rateLimits.GetOrAdd(ip, _ => new RateLimitEntry());
        var attempts = Interlocked.Increment(ref entry.FailedAttempts);

        if (attempts >= 10)
        {
            entry.BlockedUntil = _timeProvider.GetUtcNow().DateTime.AddMinutes(5);
        }
        else if (attempts >= 5)
        {
            entry.BlockedUntil = _timeProvider.GetUtcNow().DateTime.AddSeconds(30);
        }
    }

    /// <summary>
    /// Clears all failed login attempts for an IP address.
    /// </summary>
    public void ResetAttempts(string ip)
    {
        _rateLimits.TryRemove(ip, out _);
    }

    /// <summary>
    /// Gets the remaining lockout time for an IP address, or null if not locked out.
    /// </summary>
    public TimeSpan? GetRemainingLockout(string ip)
    {
        if (!_rateLimits.TryGetValue(ip, out var entry))
        {
            return null;
        }

        var remaining = entry.BlockedUntil - _timeProvider.GetUtcNow().DateTime;
        return remaining > TimeSpan.Zero ? remaining : null;
    }

    /// <summary>
    /// Invalidates all existing sessions by rotating the session secret.
    /// </summary>
    public void InvalidateAllSessions()
    {
        var settings = _settingsService.Load();
        settings.SessionSecret = GenerateSessionSecret();
        _settingsService.Save(settings);
    }

    private void EnsureSessionSecret(MidTermSettings settings)
    {
        if (string.IsNullOrEmpty(settings.SessionSecret))
        {
            settings.SessionSecret = GenerateSessionSecret();
            _settingsService.Save(settings);
        }
    }

    private static string GenerateSessionSecret()
    {
        return Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
    }

    private static string ComputeHmac(string data, string secret)
    {
        using var hmac = new HMACSHA256(Convert.FromBase64String(secret));
        var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(data));
        return Convert.ToBase64String(hash);
    }

    private sealed class RateLimitEntry
    {
        public int FailedAttempts;
        private long _blockedUntilTicks;

        public DateTime BlockedUntil
        {
            get => new(Interlocked.Read(ref _blockedUntilTicks));
            set => Interlocked.Exchange(ref _blockedUntilTicks, value.Ticks);
        }
    }
}
