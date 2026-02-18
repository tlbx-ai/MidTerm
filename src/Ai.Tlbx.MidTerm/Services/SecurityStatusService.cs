using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Settings;

using Ai.Tlbx.MidTerm.Services.Secrets;
using Ai.Tlbx.MidTerm.Services.Certificates;
using Ai.Tlbx.MidTerm.Models.Auth;
using Ai.Tlbx.MidTerm.Models.Certificates;
using Ai.Tlbx.MidTerm.Models.Files;
using Ai.Tlbx.MidTerm.Models.History;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Models.System;
namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Reports current security status (password protection, certificate trust).
/// This is INFORMATIONAL ONLY - it does not block access on degraded security.
/// Future: Add EnforceStrictSecurity setting that denies access when warnings exist.
/// </summary>
public sealed class SecurityStatusService
{
    private readonly SettingsService _settingsService;
    private readonly CertificateInfoService _certInfoService;

    public SecurityStatusService(SettingsService settingsService, CertificateInfoService certInfoService)
    {
        _settingsService = settingsService;
        _certInfoService = certInfoService;
    }

    public SecurityStatus GetStatus()
    {
        var warnings = new List<string>();
        var secrets = _settingsService.SecretStorage;

        if (secrets.LoadFailed)
        {
            warnings.Add($"Secret storage failed to load: {secrets.LoadError}");
        }

        var currentSettings = _settingsService.Load();

        if (currentSettings.AuthenticationEnabled)
        {
            var hash = secrets.GetSecret(SecretKeys.PasswordHash);
            if (string.IsNullOrEmpty(hash))
            {
                warnings.Add("Authentication enabled but no password hash found - password protection lost");
            }
        }

        if (_certInfoService.IsFallbackCertificate)
        {
            warnings.Add("Using fallback certificate - HTTPS may be untrusted");
        }

        return new SecurityStatus
        {
            PasswordProtected = currentSettings.AuthenticationEnabled && !string.IsNullOrEmpty(secrets.GetSecret(SecretKeys.PasswordHash)),
            CertificateTrusted = !_certInfoService.IsFallbackCertificate,
            Warnings = warnings
        };
    }
}
