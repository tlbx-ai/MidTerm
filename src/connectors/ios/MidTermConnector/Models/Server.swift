import Foundation

struct Server: Codable {
    var url: String
    var lastConnected: Date

    init(url: String, lastConnected: Date = .distantPast) {
        self.url = Server.normalizeUrl(url)
        self.lastConnected = lastConnected
    }

    static func normalizeUrl(_ url: String) -> String {
        var u = url.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if !u.hasPrefix("http://") && !u.hasPrefix("https://") {
            u = "https://\(u)"
        }
        return u
    }
}
