import SwiftUI

struct AddEditServerView: View {
    private let existingServer: Server?
    private let onSave: (Server) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var address: String
    @State private var errorMessage: String?

    init(server: Server?, onSave: @escaping (Server) -> Void) {
        existingServer = server
        self.onSave = onSave
        _name = State(initialValue: server?.name ?? "")
        _address = State(initialValue: server?.url ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Instance") {
                    TextField("Name (optional)", text: $name)
                        .textInputAutocapitalization(.words)
                    TextField("https://hostname:2000", text: $address)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Text("HTTPS is added automatically when you enter only host:port.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Certificate") {
                    Text("For a private certificate, compare its SHA-256 fingerprint with mt --fingerprint on the host before installing and trusting it in iOS Settings. Invalid certificates are blocked.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle(existingServer == nil ? "Add instance" : "Edit instance")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save and open") { save() }
                        .disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .alert("Address not saved", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "Enter a valid tlbx address.")
            }
        }
    }

    private func save() {
        do {
            let server = try Server(
                id: existingServer?.id ?? UUID(),
                name: name,
                url: address,
                lastConnected: existingServer?.lastConnected ?? .distantPast,
                lastRefresh: existingServer?.lastRefresh ?? .distantPast
            )
            onSave(server)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
