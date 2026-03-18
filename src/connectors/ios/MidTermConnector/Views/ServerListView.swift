import SwiftUI

struct ServerListView: View {
    @StateObject private var store = ServerStore()
    @State private var showingAdd = false
    @State private var editingServer: Server?
    @State private var selectedServer: Server?

    var body: some View {
        NavigationStack {
            Group {
                if store.servers.isEmpty {
                    VStack {
                        Spacer()
                        Text("Tap + to add a MidTerm server")
                            .foregroundStyle(.secondary)
                        Spacer()
                    }
                } else {
                    List {
                        ForEach(store.servers) { server in
                            ServerRow(server: server)
                                .contentShape(Rectangle())
                                .onTapGesture { connect(server) }
                                .swipeActions(edge: .trailing) {
                                    Button(role: .destructive) { store.delete(server) } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                    Button { editingServer = server } label: {
                                        Label("Edit", systemImage: "pencil")
                                    }
                                    .tint(.blue)
                                }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("MidTerm")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showingAdd = true } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .sheet(isPresented: $showingAdd) {
                AddEditServerView(store: store, server: nil)
            }
            .sheet(item: $editingServer) { server in
                AddEditServerView(store: store, server: server)
            }
            .fullScreenCover(item: $selectedServer) { server in
                TerminalView(server: server, store: store)
            }
        }
    }

    private func connect(_ server: Server) {
        var updated = server
        updated.lastConnected = Date()
        store.update(updated)
        selectedServer = server
    }
}

private struct ServerRow: View {
    let server: Server

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(server.name)
                .font(.headline)
            Text(server.url)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}
