using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace Ai.Tlbx.MidTerm.Services.Security;

public sealed class EncryptedFileProtector : ICertificateProtector
{
    private const int Pbkdf2Iterations = 100000;
    private readonly string _keyStorePath;
    private readonly byte[] _machineKey;

    public EncryptedFileProtector(string settingsDirectory)
    {
        _keyStorePath = settingsDirectory;
        _machineKey = DeriveMachineKey(settingsDirectory);
    }

    public bool IsAvailable => true;

    public void StorePrivateKey(byte[] privateKeyBytes, string keyId)
    {
        if (!Directory.Exists(_keyStorePath))
        {
            Directory.CreateDirectory(_keyStorePath);
        }

        using var aes = Aes.Create();
        aes.KeySize = 256;
        aes.GenerateIV();

        var keyPath = GetKeyPath(keyId);

        // Derive encryption key from machine key
        var encryptionKey = Rfc2898DeriveBytes.Pbkdf2(
            _machineKey,
            aes.IV,
            Pbkdf2Iterations,
            HashAlgorithmName.SHA256,
            32);

        aes.Key = encryptionKey;

        using var encryptor = aes.CreateEncryptor();
        var encrypted = encryptor.TransformFinalBlock(privateKeyBytes, 0, privateKeyBytes.Length);

        // File format: [16 bytes IV][encrypted data]
        using var fs = new FileStream(keyPath, FileMode.Create, FileAccess.Write);
        fs.Write(aes.IV);
        fs.Write(encrypted);

        // Set restrictive permissions on Unix
        if (!OperatingSystem.IsWindows())
        {
            SetUnixFilePermissions(keyPath);
        }
    }

    public byte[] RetrievePrivateKey(string keyId)
    {
        var keyPath = GetKeyPath(keyId);
        if (!File.Exists(keyPath))
        {
            throw new FileNotFoundException($"Protected key not found: {keyId}");
        }

        var fileBytes = File.ReadAllBytes(keyPath);
        if (fileBytes.Length < 17) // 16 bytes IV + at least 1 byte data
        {
            throw new InvalidDataException("Invalid encrypted key file format");
        }

        var iv = fileBytes.AsSpan(0, 16).ToArray();
        var encrypted = fileBytes.AsSpan(16).ToArray();

        var encryptionKey = Rfc2898DeriveBytes.Pbkdf2(
            _machineKey,
            iv,
            Pbkdf2Iterations,
            HashAlgorithmName.SHA256,
            32);

        using var aes = Aes.Create();
        aes.KeySize = 256;
        aes.Key = encryptionKey;
        aes.IV = iv;

        using var decryptor = aes.CreateDecryptor();
        return decryptor.TransformFinalBlock(encrypted, 0, encrypted.Length);
    }

    public void DeletePrivateKey(string keyId)
    {
        var keyPath = GetKeyPath(keyId);
        if (File.Exists(keyPath))
        {
            File.Delete(keyPath);
        }
    }

    public X509Certificate2 LoadCertificateWithPrivateKey(string certificatePath, string keyId)
    {
        var certPem = File.ReadAllText(certificatePath);
        using var cert = X509Certificate2.CreateFromPem(certPem);

        var privateKeyBytes = RetrievePrivateKey(keyId);
        try
        {
            X509Certificate2 certWithKey;
            try
            {
                using var ecdsa = ECDsa.Create();
                ecdsa.ImportPkcs8PrivateKey(privateKeyBytes, out _);
                certWithKey = cert.CopyWithPrivateKey(ecdsa);
            }
            catch
            {
                // Try RSA if ECDSA fails
                using var rsa = RSA.Create();
                rsa.ImportPkcs8PrivateKey(privateKeyBytes, out _);
                certWithKey = cert.CopyWithPrivateKey(rsa);
            }

            // CopyWithPrivateKey returns a cert that references the key object.
            // When the key is disposed, the cert's private key becomes invalid.
            // Export to PFX and reload to get a self-contained certificate.
            var pfxBytes = certWithKey.Export(X509ContentType.Pfx);
            certWithKey.Dispose();

            var result = X509CertificateLoader.LoadPkcs12(pfxBytes, null,
                X509KeyStorageFlags.Exportable);
            CryptographicOperations.ZeroMemory(pfxBytes);
            return result;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(privateKeyBytes);
        }
    }

    private string GetKeyPath(string keyId)
    {
        return Path.Combine(_keyStorePath, $"{keyId}.key.enc");
    }

    private static byte[] DeriveMachineKey(string settingsDirectory)
    {
        var machineId = GetMachineId();
        var combinedSeed = $"{machineId}:{settingsDirectory}";
        return SHA256.HashData(Encoding.UTF8.GetBytes(combinedSeed));
    }

    private static string GetMachineId()
    {
        // Try Linux machine-id first
        const string linuxMachineIdPath = "/etc/machine-id";
        if (File.Exists(linuxMachineIdPath))
        {
            return File.ReadAllText(linuxMachineIdPath).Trim();
        }

        // Try macOS hardware UUID
        if (OperatingSystem.IsMacOS())
        {
            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = "ioreg",
                    Arguments = "-rd1 -c IOPlatformExpertDevice",
                    RedirectStandardOutput = true,
                    UseShellExecute = false
                };
                using var process = System.Diagnostics.Process.Start(psi);
                if (process is not null)
                {
                    var output = process.StandardOutput.ReadToEnd();
                    var match = System.Text.RegularExpressions.Regex.Match(
                        output,
                        @"""IOPlatformUUID""\s*=\s*""([^""]+)""");
                    if (match.Success)
                    {
                        return match.Groups[1].Value;
                    }
                }
            }
            catch
            {
                // Ignore errors, fall through to fallback
            }
        }

        // Fallback: use hostname + current user
        return $"{Environment.MachineName}:{Environment.UserName}";
    }

    private static void SetUnixFilePermissions(string path)
    {
        try
        {
            // chmod 600 - owner read/write only
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "chmod",
                Arguments = $"600 \"{path}\"",
                UseShellExecute = false
            };
            using var process = System.Diagnostics.Process.Start(psi);
            process?.WaitForExit(1000);
        }
        catch
        {
            // Best effort - ignore failures
        }
    }
}
