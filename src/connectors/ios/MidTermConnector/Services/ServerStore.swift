import Foundation
import Security

final class ServerStore: ObservableObject {
    @Published var servers: [Server] = []

    private let service = "ai.tlbx.midterm.servers"
    private let account = "server_list"

    init() {
        servers = load()
    }

    func save() {
        guard let data = try? JSONEncoder().encode(servers) else { return }
        deleteKeychainItem()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    func add(_ server: Server) {
        servers.append(server)
        save()
    }

    func update(_ server: Server) {
        guard let idx = servers.firstIndex(where: { $0.id == server.id }) else { return }
        servers[idx] = server
        save()
    }

    func delete(_ server: Server) {
        servers.removeAll { $0.id == server.id }
        save()
    }

    func updateFingerprint(serverId: String, fingerprint: String) {
        guard let idx = servers.firstIndex(where: { $0.id == serverId }) else { return }
        servers[idx].certFingerprint = fingerprint
        save()
    }

    private func load() -> [Server] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return [] }
        return (try? JSONDecoder().decode([Server].self, from: data)) ?? []
    }

    private func deleteKeychainItem() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}
