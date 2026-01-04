using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class AuthService
{
    private const int Iterations = 100_000;
    private const int SaltSize = 32;
    private const int HashSize = 32;
    private const int SessionTokenValidityHours = 24 * 21; // 3 weeks

    private readonly SettingsService _settingsService;
    private readonly ConcurrentDictionary<string, RateLimitEntry> _rateLimits = new();

    public AuthService(SettingsService settingsService)
    {
        _settingsService = settingsService;

        // Ensure session secret exists on startup so cookies survive restarts
        var settings = _settingsService.Load();
        if (string.IsNullOrEmpty(settings.SessionSecret))
        {
            settings.SessionSecret = GenerateSessionSecret();
            _settingsService.Save(settings);
        }
    }

    public string HashPassword(string password)
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

        // Handle pending password from installer (plaintext with prefix)
        if (storedHash.StartsWith("__PENDING__:"))
        {
            var pendingPassword = storedHash["__PENDING__:".Length..];
            if (password == pendingPassword)
            {
                // Convert to proper hash on successful match
                var settings = _settingsService.Load();
                settings.PasswordHash = HashPassword(password);
                _settingsService.Save(settings);
                return true;
            }
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

    public string CreateSessionToken()
    {
        var settings = _settingsService.Load();
        EnsureSessionSecret(settings);

        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var signature = ComputeHmac(timestamp.ToString(), settings.SessionSecret!);

        return $"{timestamp}:{signature}";
    }

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
        if (DateTimeOffset.UtcNow - tokenTime > TimeSpan.FromHours(SessionTokenValidityHours))
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

    public bool IsRateLimited(string ip)
    {
        if (!_rateLimits.TryGetValue(ip, out var entry))
        {
            return false;
        }

        if (DateTime.UtcNow > entry.BlockedUntil)
        {
            _rateLimits.TryRemove(ip, out _);
            return false;
        }

        return true;
    }

    public void RecordFailedAttempt(string ip)
    {
        var entry = _rateLimits.GetOrAdd(ip, _ => new RateLimitEntry());
        entry.FailedAttempts++;

        if (entry.FailedAttempts >= 10)
        {
            entry.BlockedUntil = DateTime.UtcNow.AddMinutes(5);
        }
        else if (entry.FailedAttempts >= 5)
        {
            entry.BlockedUntil = DateTime.UtcNow.AddSeconds(30);
        }
    }

    public void ResetAttempts(string ip)
    {
        _rateLimits.TryRemove(ip, out _);
    }

    public TimeSpan? GetRemainingLockout(string ip)
    {
        if (!_rateLimits.TryGetValue(ip, out var entry))
        {
            return null;
        }

        var remaining = entry.BlockedUntil - DateTime.UtcNow;
        return remaining > TimeSpan.Zero ? remaining : null;
    }

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
        public int FailedAttempts { get; set; }
        public DateTime BlockedUntil { get; set; }
    }
}
