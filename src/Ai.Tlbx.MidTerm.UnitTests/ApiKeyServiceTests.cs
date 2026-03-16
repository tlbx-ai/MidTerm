using Ai.Tlbx.MidTerm.Services.Security;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class ApiKeyServiceTests : IDisposable
{
    private readonly string _tempDir;
    private readonly SettingsService _settingsService;
    private readonly FakeTimeProvider _timeProvider;
    private readonly ApiKeyService _apiKeyService;

    public ApiKeyServiceTests()
    {
        if (!OperatingSystem.IsWindows())
        {
            _tempDir = string.Empty;
            _settingsService = null!;
            _timeProvider = null!;
            _apiKeyService = null!;
            return;
        }

        _tempDir = Path.Combine(Path.GetTempPath(), $"midterm_apikey_test_{Guid.NewGuid():N}");
        Directory.CreateDirectory(_tempDir);
        _settingsService = new SettingsService(_tempDir);
        _timeProvider = new FakeTimeProvider(DateTimeOffset.UtcNow);
        _apiKeyService = new ApiKeyService(_settingsService, _timeProvider);
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
        }
    }

    [Fact]
    public void CreateApiKey_ListAndValidate_RoundTrip()
    {
        if (!IsWindows) return;

        var created = _apiKeyService.CreateApiKey("Primary Agent");
        var listed = _apiKeyService.ListApiKeys();

        Assert.StartsWith("mtk_", created.Token);
        Assert.Single(listed.ApiKeys);
        Assert.Equal("Primary Agent", listed.ApiKeys[0].Name);
        Assert.True(_apiKeyService.TryValidateApiKey(created.Token, out var validated));
        Assert.NotNull(validated);
        Assert.Equal(created.ApiKey.Id, validated!.Id);
    }

    [Fact]
    public void TryValidateApiKey_SetsLastUsedTimestamp()
    {
        if (!IsWindows) return;

        var created = _apiKeyService.CreateApiKey("Observer");
        Assert.Null(_apiKeyService.ListApiKeys().ApiKeys[0].LastUsedAtUtc);

        Assert.True(_apiKeyService.TryValidateApiKey(created.Token, out _));

        var listed = _apiKeyService.ListApiKeys();
        Assert.NotNull(listed.ApiKeys[0].LastUsedAtUtc);
    }

    [Fact]
    public void DeleteApiKey_RemovesKeyAndInvalidatesToken()
    {
        if (!IsWindows) return;

        var created = _apiKeyService.CreateApiKey("Disposable");

        Assert.True(_apiKeyService.DeleteApiKey(created.ApiKey.Id));
        Assert.Empty(_apiKeyService.ListApiKeys().ApiKeys);
        Assert.False(_apiKeyService.TryValidateApiKey(created.Token, out _));
    }
}
