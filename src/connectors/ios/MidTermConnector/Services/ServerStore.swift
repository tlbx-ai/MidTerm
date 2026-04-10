import Foundation

final class ServerStore: ObservableObject {
    @Published var server: Server?

    private let defaultsKey = "ai.tlbx.midterm.server"

    init() {
        server = load()
    }

    func save(url: String) {
        let normalizedUrl = Server.normalizeUrl(url)
        let lastConnected = server?.lastConnected ?? .distantPast
        server = Server(url: normalizedUrl, lastConnected: lastConnected)
        persist()
    }

    func markConnected() {
        guard var current = server else { return }
        current.lastConnected = Date()
        server = current
        persist()
    }

    private func load() -> Server? {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey) else { return nil }
        return try? JSONDecoder().decode(Server.self, from: data)
    }

    private func persist() {
        guard let server, let data = try? JSONEncoder().encode(server) else {
            UserDefaults.standard.removeObject(forKey: defaultsKey)
            return
        }
        UserDefaults.standard.set(data, forKey: defaultsKey)
    }
}
