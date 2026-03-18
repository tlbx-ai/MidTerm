import SwiftUI

struct AddEditServerView: View {
    @ObservedObject var store: ServerStore
    let server: Server?
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var url = ""
    @State private var password = ""

    private var isEditing: Bool { server != nil }

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("Server name", text: $name)
                        .textContentType(.name)
                        .autocorrectionDisabled()
                    TextField("https://hostname:2000", text: $url)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .autocapitalization(.none)
                        .autocorrectionDisabled()
                }
                Section("Authentication") {
                    SecureField("Password (optional)", text: $password)
                        .textContentType(.password)
                }
            }
            .navigationTitle(isEditing ? "Edit Server" : "Add Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty ||
                                  url.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear {
                if let server {
                    name = server.name
                    url = server.url
                    password = server.password
                }
            }
        }
    }

    private func save() {
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        let trimmedUrl = url.trimmingCharacters(in: .whitespaces)
        guard !trimmedName.isEmpty, !trimmedUrl.isEmpty else { return }

        if var existing = server {
            existing.name = trimmedName
            existing.url = Server.normalizeUrl(trimmedUrl)
            existing.password = password
            store.update(existing)
        } else {
            store.add(Server(name: trimmedName, url: trimmedUrl, password: password))
        }
        dismiss()
    }
}
