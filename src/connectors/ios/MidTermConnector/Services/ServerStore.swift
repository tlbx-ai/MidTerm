import Foundation
import Combine

final class ServerStore: ObservableObject {
    @Published private(set) var servers: [Server] = []
    @Published private(set) var activeID: UUID?

    init() { reload() }

    var active: Server? {
        servers.first { $0.id == activeID } ?? servers.first
    }

    func reload() {
        servers = Self.loadPersistedServers()
        activeID = UserDefaults.standard.string(forKey: Self.activeKey).flatMap(UUID.init(uuidString:))
        if activeID == nil { activeID = servers.first?.id }
    }

    func save(_ server: Server, makeActive: Bool = true) {
        if let index = servers.firstIndex(where: { $0.id == server.id }) {
            servers[index] = server
        } else {
            servers.append(server)
        }
        if makeActive { activeID = server.id }
        persist()
    }

    func delete(_ server: Server) {
        servers.removeAll { $0.id == server.id }
        if activeID == server.id { activeID = servers.first?.id }
        persist()
    }

    func markConnected(_ id: UUID) {
        guard let index = servers.firstIndex(where: { $0.id == id }) else { return }
        servers[index].lastConnected = Date()
        persist()
    }

    private func persist() {
        Self.persist(servers: servers, activeID: activeID)
    }

    static func loadPersistedServers() -> [Server] {
        let defaults = UserDefaults.standard
        if let data = defaults.data(forKey: serversKey),
           let decoded = try? JSONDecoder().decode([Server].self, from: data) {
            return decoded
        }
        guard let legacyData = defaults.data(forKey: legacyKey),
              let legacy = try? JSONDecoder().decode(Server.self, from: legacyData) else { return [] }
        persist(servers: [legacy], activeID: legacy.id)
        defaults.removeObject(forKey: legacyKey)
        return [legacy]
    }

    static func markRefreshed(_ ids: Set<UUID>) {
        var servers = loadPersistedServers()
        let now = Date()
        for index in servers.indices where ids.contains(servers[index].id) {
            servers[index].lastRefresh = now
        }
        let activeID = UserDefaults.standard.string(forKey: activeKey).flatMap(UUID.init(uuidString:))
        persist(servers: servers, activeID: activeID)
    }

    private static func persist(servers: [Server], activeID: UUID?) {
        let defaults = UserDefaults.standard
        if let data = try? JSONEncoder().encode(servers) {
            defaults.set(data, forKey: serversKey)
        }
        defaults.set(activeID?.uuidString, forKey: activeKey)
    }

    private static let serversKey = "ai.tlbx.app.servers.v2"
    private static let activeKey = "ai.tlbx.app.active-server"
    private static let legacyKey = "ai.tlbx.app.server"
}
