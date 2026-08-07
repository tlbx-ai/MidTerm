import SwiftUI

struct ConnectionManagerView: View {
    @ObservedObject var store: ServerStore
    @State private var selectedServer: Server?
    @State private var editedServer: Server?
    @State private var showingEditor = false
    @State private var attemptedAutomaticOpen = false

    var body: some View {
        NavigationStack {
            Group {
                if store.servers.isEmpty {
                    VStack(spacing: 14) {
                        Image(systemName: "shippingbox")
                            .font(.system(size: 54))
                            .foregroundStyle(.blue)
                        Text("Connect your tlbx")
                            .font(.title2.bold())
                        Text("Add the HTTPS address of your tlbx instance. You can add and switch between more instances later.")
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                        Button("Add instance") { presentEditor(nil) }
                            .buttonStyle(.borderedProminent)
                    }
                    .padding(32)
                } else {
                    List {
                        Section("Instances") {
                            ForEach(store.servers) { server in
                                Button {
                                    store.save(server)
                                    selectedServer = server
                                } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        HStack {
                                            Text(server.name).font(.headline)
                                            if store.activeID == server.id {
                                                Image(systemName: "checkmark.circle.fill")
                                                    .foregroundStyle(.blue)
                                            }
                                        }
                                        Text(server.url)
                                            .font(.footnote)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                }
                                .buttonStyle(.plain)
                                .swipeActions(edge: .trailing) {
                                    Button(role: .destructive) { store.delete(server) } label: {
                                        Label("Remove", systemImage: "trash")
                                    }
                                    Button { presentEditor(server) } label: {
                                        Label("Edit", systemImage: "pencil")
                                    }
                                    .tint(.blue)
                                }
                                .contextMenu {
                                    Button("Edit") { presentEditor(server) }
                                    Button("Remove", role: .destructive) { store.delete(server) }
                                }
                            }
                        }

                        Section("Background behavior") {
                            Text("tlbx keeps the WebView and its session in memory while iOS allows it, requests best-effort background refresh, and reconnects when you return. iOS may suspend or close any background app.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("tlbx connections")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { presentEditor(nil) } label: {
                        Label("Add instance", systemImage: "plus")
                    }
                }
            }
            .onAppear {
                store.reload()
                guard !attemptedAutomaticOpen else { return }
                attemptedAutomaticOpen = true
                if let active = store.active {
                    selectedServer = active
                } else {
                    presentEditor(nil)
                }
            }
            .sheet(isPresented: $showingEditor) {
                AddEditServerView(server: editedServer) { server in
                    store.save(server)
                    selectedServer = server
                }
            }
            .fullScreenCover(item: $selectedServer) { server in
                TerminalView(server: server) {
                    selectedServer = nil
                    store.reload()
                }
            }
        }
    }

    private func presentEditor(_ server: Server?) {
        editedServer = server
        showingEditor = true
    }
}
