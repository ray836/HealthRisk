import SwiftUI

enum GameJoinCode {
    static func displayCode(from gameID: String) -> String {
        let lowered = gameID.lowercased()
        let code = lowered.hasPrefix("game-") ? String(lowered.dropFirst(5)) : lowered
        return code.uppercased()
    }

    static func gameID(from input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let withoutQuery = trimmed.split(separator: "?", maxSplits: 1).first.map(String.init) ?? trimmed
        let lastPathComponent = withoutQuery.split(separator: "/").last.map(String.init) ?? withoutQuery
        let lowered = lastPathComponent.lowercased()
        let code = lowered.hasPrefix("game-") ? String(lowered.dropFirst(5)) : lowered
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789")

        guard code.count == 6,
              code.unicodeScalars.allSatisfy(allowed.contains) else {
            return nil
        }
        return "game-\(code)"
    }
}

struct JoinGameView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: GamesStore
    let onJoin: @MainActor (String) async -> Bool

    @State private var code = ""
    @State private var validationMessage: String?
    @FocusState private var isCodeFocused: Bool

    var body: some View {
        NavigationStack {
            ZStack {
                HealthRiskTheme.appBackground

                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        introduction
                        codeEntry

                        if let validationMessage {
                            Label(validationMessage, systemImage: "exclamationmark.triangle.fill")
                                .font(.callout.weight(.semibold))
                                .foregroundStyle(HealthRiskTheme.danger)
                        }

                        if let error = store.joinError {
                            ServerErrorView(error: error)
                        }

                        joinButton
                    }
                    .padding(18)
                }
            }
            .navigationTitle("Join Game")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(store.isJoining)
                }
            }
        }
        .foregroundStyle(HealthRiskTheme.text)
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(store.isJoining)
        .onAppear { isCodeFocused = true }
        .onChange(of: code) { _, _ in
            validationMessage = nil
            store.clearJoinError()
        }
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Enter an invite code")
                .font(.title2.bold())
            Text("Ask the game creator for the six-character code, or paste the full invite link.")
                .font(.subheadline)
                .foregroundStyle(HealthRiskTheme.muted)
        }
    }

    private var codeEntry: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Game Code", systemImage: "number")
                .font(.headline)
                .foregroundStyle(HealthRiskTheme.accent)

            TextField("JEN36X", text: $code)
                .font(.title3.monospaced().weight(.semibold))
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .submitLabel(.join)
                .focused($isCodeFocused)
                .onSubmit { submit() }
                .padding(14)
                .background(HealthRiskTheme.background)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(HealthRiskTheme.line, lineWidth: 1)
                }

            Text("Examples: JEN36X or game-jen36x")
                .font(.caption)
                .foregroundStyle(HealthRiskTheme.muted)
        }
        .padding(18)
        .healthRiskSurface()
    }

    private var joinButton: some View {
        Button(action: submit) {
            HStack(spacing: 9) {
                if store.isJoining {
                    ProgressView().tint(.white)
                } else {
                    Image(systemName: "person.badge.plus")
                }
                Text(store.isJoining ? "Joining…" : "Join Game")
                    .fontWeight(.bold)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 50)
        }
        .buttonStyle(.borderedProminent)
        .tint(HealthRiskTheme.accent)
        .disabled(store.isJoining || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private func submit() {
        guard !store.isJoining else { return }
        guard let gameId = GameJoinCode.gameID(from: code) else {
            validationMessage = "Enter the six-character code from the invitation."
            return
        }

        isCodeFocused = false
        Task {
            if await onJoin(gameId) {
                dismiss()
            }
        }
    }
}
