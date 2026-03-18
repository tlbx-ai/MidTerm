import Foundation
import CryptoKit

enum CertificateTrust {
    static func fingerprint(of trust: SecTrust) -> String? {
        guard let cert = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = cert.first else { return nil }
        let data = SecCertificateCopyData(leaf) as Data
        let hash = SHA256.hash(data: data)
        return hash.map { String(format: "%02X", $0) }.joined(separator: ":")
    }

    static func performLogin(url: String, password: String) async -> [HTTPCookie] {
        guard let loginUrl = URL(string: "\(url)/api/auth/login") else { return [] }

        var request = URLRequest(url: loginUrl)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let escaped = password.replacingOccurrences(of: "\"", with: "\\\"")
        request.httpBody = "{\"password\":\"\(escaped)\"}".data(using: .utf8)

        let session = URLSession(configuration: .ephemeral, delegate: TrustAllDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }

        guard let (_, response) = try? await session.data(for: request),
              let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200,
              let headerFields = httpResponse.allHeaderFields as? [String: String],
              let responseUrl = httpResponse.url else { return [] }

        return HTTPCookie.cookies(withResponseHeaderFields: headerFields, for: responseUrl)
    }
}

final class TrustAllDelegate: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge) async
        -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            return (.performDefaultHandling, nil)
        }
        return (.useCredential, URLCredential(trust: trust))
    }
}
