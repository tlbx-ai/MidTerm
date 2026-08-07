import SwiftUI

struct AddEditServerView: View {
    private let existingServer: Server?
    private let onSave: (Server) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var address: String
    @State private var allowUntrustedCertificate: Bool
    @State private var errorMessage: String?

    init(server: Server?, onSave: @escaping (Server) -> Void) {
        existingServer = server
        self.onSave = onSave
        _name = State(initialValue: server?.name ?? "")
        _address = State(initialValue: server?.url ?? "")
        _allowUntrustedCertificate = State(initialValue: server?.allowUntrustedCertificate ?? false)
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
                    Toggle("Allow a private or self-signed certificate", isOn: $allowUntrustedCertificate)
                    Text("Only enable this for an instance you control. A publicly trusted certificate is safer.")
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
                allowUntrustedCertificate: allowUntrustedCertificate,
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
