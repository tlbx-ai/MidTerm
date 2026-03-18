import Foundation

struct Server: Identifiable, Codable {
    var id: String
    var name: String
    var url: String
    var password: String
    var certFingerprint: String
    var lastConnected: Date

    init(name: String, url: String, password: String = "", certFingerprint: String = "") {
        self.id = UUID().uuidString
        self.name = name
        self.url = Server.normalizeUrl(url)
        self.password = password
        self.certFingerprint = certFingerprint
        self.lastConnected = .distantPast
    }

    static func normalizeUrl(_ url: String) -> String {
        var u = url.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if !u.hasPrefix("http://") && !u.hasPrefix("https://") {
            u = "https://\(u)"
        }
        return u
    }
}
