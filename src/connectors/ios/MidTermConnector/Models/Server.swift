import Foundation

struct Server: Codable, Identifiable, Equatable {
    let id: UUID
    var name: String
    var url: String
    var lastConnected: Date
    var lastRefresh: Date

    init(
        id: UUID = UUID(),
        name: String,
        url: String,
        lastConnected: Date = .distantPast,
        lastRefresh: Date = .distantPast
    ) throws {
        let normalizedURL = try Server.normalizeURL(url)
        self.id = id
        self.name = name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? Server.defaultName(for: normalizedURL)
            : name.trimmingCharacters(in: .whitespacesAndNewlines)
        self.url = normalizedURL
        self.lastConnected = lastConnected
        self.lastRefresh = lastRefresh
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, url, lastConnected, lastRefresh
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let normalizedURL = try Server.normalizeURL(try values.decode(String.self, forKey: .url))
        id = try values.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        name = try values.decodeIfPresent(String.self, forKey: .name)
            .flatMap { $0.isEmpty ? nil : $0 } ?? Server.defaultName(for: normalizedURL)
        url = normalizedURL
        lastConnected = try values.decodeIfPresent(Date.self, forKey: .lastConnected) ?? .distantPast
        lastRefresh = try values.decodeIfPresent(Date.self, forKey: .lastRefresh) ?? .distantPast
    }

    static func normalizeURL(_ input: String) throws -> String {
        var value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasSuffix("/") { value.removeLast() }
        guard !value.isEmpty else { throw ServerValidationError.addressRequired }
        if !value.contains("://") { value = "https://\(value)" }

        guard var components = URLComponents(string: value),
              components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty else {
            throw ServerValidationError.invalidHTTPSAddress
        }
        guard components.user == nil, components.password == nil else {
            throw ServerValidationError.credentialsInAddress
        }
        guard components.fragment == nil else { throw ServerValidationError.fragmentInAddress }
        components.scheme = "https"
        guard let normalized = components.url?.absoluteString else {
            throw ServerValidationError.invalidHTTPSAddress
        }
        return normalized.hasSuffix("/") ? String(normalized.dropLast()) : normalized
    }

    static func defaultName(for url: String) -> String {
        guard let components = URLComponents(string: url), let host = components.host else { return "tlbx" }
        return components.port.map { "\(host):\($0)" } ?? host
    }
}

enum ServerValidationError: LocalizedError {
    case addressRequired
    case invalidHTTPSAddress
    case credentialsInAddress
    case fragmentInAddress

    var errorDescription: String? {
        switch self {
        case .addressRequired: return "Enter a tlbx address."
        case .invalidHTTPSAddress: return "Enter a valid HTTPS tlbx address."
        case .credentialsInAddress: return "Do not put credentials in the address."
        case .fragmentInAddress: return "Remove the address fragment."
        }
    }
}
