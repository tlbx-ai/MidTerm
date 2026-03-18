import SwiftUI

@main
struct MidTermConnectorApp: App {
    var body: some Scene {
        WindowGroup {
            ServerListView()
                .preferredColorScheme(.dark)
        }
    }
}
