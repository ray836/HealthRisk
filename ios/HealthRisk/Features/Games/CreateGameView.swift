import SwiftUI

struct CreateGameView: View {
    private enum GameMode: String, CaseIterable, Identifiable {
        case multiplayer = "Multiplayer"
        case practice = "Practice"

        var id: String { rawValue }
    }

    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: GamesStore
    let onCreate: @MainActor (CreateGameRequest) async -> Bool

    @State private var mode: GameMode = .multiplayer
    @State private var practicePlayerCount = 2

    var body: some View {
        NavigationStack {
            ZStack {
                HealthRiskTheme.appBackground

                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        introduction
                        modePicker
                        gameDetails

                        if let error = store.createError {
                            ServerErrorView(error: error)
                        }

                        createButton
                    }
                    .padding(18)
                }
            }
            .navigationTitle("Create Game")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(store.isCreating)
                }
            }
        }
        .foregroundStyle(HealthRiskTheme.text)
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(store.isCreating)
        .onChange(of: mode) { _, _ in store.clearCreateError() }
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Choose your campaign")
                .font(.title2.bold())
            Text("The HealthRisk server creates the board, applies the health rules, and validates every move.")
                .font(.subheadline)
                .foregroundStyle(HealthRiskTheme.muted)
        }
    }

    private var modePicker: some View {
        Picker("Game type", selection: $mode) {
            ForEach(GameMode.allCases) { mode in
                Text(mode.rawValue).tag(mode)
            }
        }
        .pickerStyle(.segmented)
    }

    private var gameDetails: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(
                mode == .multiplayer ? "Open Lobby" : "Solo Practice",
                systemImage: mode == .multiplayer ? "person.3.fill" : "figure.walk"
            )
            .font(.headline)
            .foregroundStyle(HealthRiskTheme.accent)

            Text(modeDescription)
                .font(.subheadline)
                .foregroundStyle(HealthRiskTheme.muted)

            if mode == .practice {
                Divider().overlay(HealthRiskTheme.line)

                Stepper(value: $practicePlayerCount, in: 2...10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Players")
                            .font(.subheadline.weight(.semibold))
                        Text("You control all \(practicePlayerCount) seats")
                            .font(.caption)
                            .foregroundStyle(HealthRiskTheme.muted)
                    }
                }
                .tint(HealthRiskTheme.accent)
            }

            Divider().overlay(HealthRiskTheme.line)

            Label("Standard health goals and daily timing are applied by the server.", systemImage: "heart.text.square")
                .font(.caption)
                .foregroundStyle(HealthRiskTheme.muted)
        }
        .padding(18)
        .healthRiskSurface()
    }

    private var modeDescription: String {
        switch mode {
        case .multiplayer:
            "Create a waiting room for up to ten players, then invite friends. At least two players must join before the campaign can start."
        case .practice:
            "Start immediately and learn the game by controlling every player on the board."
        }
    }

    private var createButton: some View {
        Button {
            Task {
                let request = CreateGameRequest(
                    practice: mode == .practice,
                    players: mode == .practice ? practicePlayerCount : nil
                )
                if await onCreate(request) {
                    dismiss()
                }
            }
        } label: {
            HStack(spacing: 9) {
                if store.isCreating {
                    ProgressView().tint(.white)
                } else {
                    Image(systemName: mode == .multiplayer ? "person.3.fill" : "play.fill")
                }
                Text(store.isCreating ? "Creating…" : createButtonTitle)
                    .fontWeight(.bold)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 50)
        }
        .buttonStyle(.borderedProminent)
        .tint(HealthRiskTheme.accent)
        .disabled(store.isCreating)
    }

    private var createButtonTitle: String {
        mode == .multiplayer ? "Create Open Lobby" : "Start Practice"
    }
}
