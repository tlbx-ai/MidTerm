import SwiftUI

struct LaunchView: View {
    @StateObject private var store = ServerStore()
    @State private var address = ""
    @State private var showingTerminal = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("A native shell for your MidTerm workspace.")
                        .font(.headline)
                        .foregroundStyle(.primary)
                    Text("Enter one MidTerm address here, then use Hub inside MidTerm to move between machines and workspaces.")
                        .foregroundStyle(.secondary)
                }

                Section("MidTerm Address") {
                    TextField("https://hostname:2000", text: $address)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Text("Paste the full URL or just host:port. HTTPS is added automatically when you omit the scheme.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                LauncherHintSection(lastConnected: store.server?.lastConnected)

                Section {
                    Button("Open MidTerm") {
                        openMidTerm()
                    }
                    .disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .navigationTitle("MidTerm")
            .onAppear {
                address = store.server?.url ?? ""
            }
            .fullScreenCover(isPresented: $showingTerminal) {
                if let server = store.server {
                    TerminalView(server: server)
                }
            }
        }
    }

    private func openMidTerm() {
        let trimmedAddress = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedAddress.isEmpty else { return }
        store.save(url: trimmedAddress)
        store.markConnected()
        address = store.server?.url ?? trimmedAddress
        showingTerminal = true
    }
}
