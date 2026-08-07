import BackgroundTasks
import Foundation
import SwiftUI

@main
struct TlbxApp: App {
    @StateObject private var store = ServerStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ConnectionManagerView(store: store)
                .preferredColorScheme(.dark)
        }
        .onChange(of: scenePhase) { phase in
            switch phase {
            case .active:
                store.reload()
            case .background:
                BackgroundRefresh.schedule()
            default:
                break
            }
        }
        .backgroundTask(.appRefresh(BackgroundRefresh.identifier)) {
            await BackgroundRefresh.run()
        }
    }
}

enum BackgroundRefresh {
    static let identifier = "ai.tlbx.app.refresh"

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    static func run() async {
        schedule()
        let servers = ServerStore.loadPersistedServers()
        let refreshed = await withTaskGroup(of: UUID?.self, returning: Set<UUID>.self) { group in
            for server in servers {
                group.addTask { await probe(server) ? server.id : nil }
            }
            var ids = Set<UUID>()
            for await id in group {
                if let id { ids.insert(id) }
            }
            return ids
        }
        if !refreshed.isEmpty { ServerStore.markRefreshed(refreshed) }
    }

    private static func probe(_ server: Server) async -> Bool {
        guard var components = URLComponents(string: server.url) else { return false }
        components.path = "/api/version"
        components.query = nil
        components.fragment = nil
        guard let url = components.url else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("tlbx-app-background-refresh", forHTTPHeaderField: "User-Agent")
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return response is HTTPURLResponse
        } catch {
            return false
        }
    }
}
