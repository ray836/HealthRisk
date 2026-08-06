import SwiftUI
import UIKit

struct WaitingRoomView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject private var authenticationStore: AuthenticationStore
    @StateObject private var store: WaitingRoomStore
    @State private var isEditingRules = false
    @State private var isConfirmingExit = false
    @State private var didCopyGameCode = false
    @State private var isEnteringGameplay = false
    private let inviteURL: URL?
    private let onLobbyExited: @MainActor () async -> Void
    private let onGameStarted: @MainActor (String) async -> Void

    init(
        gameId: String,
        inviteURL: URL?,
        api: any HealthRiskAPI,
        authenticationStore: AuthenticationStore,
        onLobbyExited: @escaping @MainActor () async -> Void,
        onGameStarted: @escaping @MainActor (String) async -> Void
    ) {
        self.authenticationStore = authenticationStore
        self.inviteURL = inviteURL
        self.onLobbyExited = onLobbyExited
        self.onGameStarted = onGameStarted
        _store = StateObject(wrappedValue: WaitingRoomStore(gameId: gameId, api: api))
    }

    var body: some View {
        ZStack {
            HealthRiskTheme.appBackground
            content
        }
        .navigationTitle("Waiting Room")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let inviteURL {
                    ShareLink(
                        item: inviteURL,
                        subject: Text("Join my HealthRisk game"),
                        message: Text("Join my HealthRisk game: \(inviteURL.absoluteString)")
                    ) {
                        Label("Share Invite", systemImage: "square.and.arrow.up")
                    }
                }

                Button {
                    Task { await load() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(store.isLoading)
            }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await synchronizeLobby()
        }
        .sheet(isPresented: $isEditingRules) {
            if let game = store.game {
                HealthRulesEditorView(store: store, game: game) {
                    await invalidateIfUnauthorized(store.rulesError)
                }
            }
        }
        .confirmationDialog(
            store.game?.isCreator == true ? "Cancel this game?" : "Leave this game?",
            isPresented: $isConfirmingExit,
            titleVisibility: .visible
        ) {
            Button(store.game?.isCreator == true ? "Cancel Game" : "Leave Game", role: .destructive) {
                Task { await exitLobby() }
            }
            Button("Keep Game", role: .cancel) {}
        } message: {
            if store.game?.isCreator == true {
                Text("This closes the waiting room for everyone. You can create and play other games without cancelling this one.")
            } else {
                Text("Your seat becomes available for another player.")
            }
        }
        .foregroundStyle(HealthRiskTheme.text)
    }

    @ViewBuilder
    private var content: some View {
        if store.isLoading && store.game == nil {
            ProgressView("Loading waiting room…")
                .tint(HealthRiskTheme.accent)
        } else if let game = store.game {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if let error = store.error {
                        ServerErrorView(error: error)
                    }
                    lobbySummary(game)
                    healthGoals(game)
                }
                .padding(18)
            }
            .refreshable { await load() }
        } else if let error = store.error {
            VStack(spacing: 16) {
                ServerErrorView(error: error)
                Button("Try Again") { Task { await load() } }
                    .buttonStyle(.borderedProminent)
                    .tint(HealthRiskTheme.accent)
            }
            .padding(18)
        }
    }

    private func lobbySummary(_ game: LobbyGameView) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            gameCodeBanner(game)

            HStack {
                Label("\(game.claimedPlayerCount)/\(game.lobbyCapacity) players", systemImage: "person.3.fill")
                    .font(.headline)
                Spacer()
                Text(game.isCreator ? "Creator" : "Player")
                    .font(.caption.bold())
                    .foregroundStyle(HealthRiskTheme.accent)
            }

            ForEach(game.players) { player in
                HStack(spacing: 11) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(HealthRiskTheme.success)
                    Text(player.name)
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    if game.lobbyHealthVoting.submittedPlayerIds.contains(player.id) {
                        Text("Goals reviewed")
                            .font(.caption)
                            .foregroundStyle(HealthRiskTheme.success)
                    } else {
                        Text("Reviewing goals")
                            .font(.caption)
                            .foregroundStyle(HealthRiskTheme.muted)
                    }
                }
            }

            let openSeats = max(0, game.lobbyCapacity - game.claimedPlayerCount)
            if openSeats > 0 {
                Label(
                    "\(openSeats) open \(openSeats == 1 ? "seat" : "seats")",
                    systemImage: "person.badge.plus"
                )
                .font(.subheadline)
                .foregroundStyle(HealthRiskTheme.muted)
            }

            if let error = store.exitError {
                ServerErrorView(error: error)
            }

            if game.isCreator {
                Divider().overlay(HealthRiskTheme.line)

                if let error = store.startError {
                    ServerErrorView(error: error)
                }

                Button {
                    Task { await startGame() }
                } label: {
                    HStack(spacing: 9) {
                        if store.isStartingGame {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "play.fill")
                        }
                        Text(
                            store.isStartingGame
                                ? "Starting…"
                                : "Start Game with \(game.claimedPlayerCount) \(game.claimedPlayerCount == 1 ? "Player" : "Players")"
                        )
                        .fontWeight(.bold)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 46)
                }
                .buttonStyle(.borderedProminent)
                .tint(HealthRiskTheme.accent)
                .disabled(store.isStartingGame || store.isExitingLobby)

                Text("The campaign starts with everyone currently joined. At least two players must join and review the health goals.")
                    .font(.caption)
                    .foregroundStyle(HealthRiskTheme.muted)
            }

            Divider().overlay(HealthRiskTheme.line)

            Button(role: .destructive) {
                isConfirmingExit = true
            } label: {
                HStack(spacing: 9) {
                    if store.isExitingLobby {
                        ProgressView().tint(HealthRiskTheme.danger)
                    } else {
                        Image(systemName: game.isCreator ? "trash" : "rectangle.portrait.and.arrow.right")
                    }
                    Text(game.isCreator ? "Cancel Game" : "Leave Game")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 40)
            }
            .buttonStyle(.bordered)
            .tint(HealthRiskTheme.danger)
            .disabled(store.isExitingLobby || store.isStartingGame)
        }
        .padding(18)
        .healthRiskSurface()
    }

    private func gameCodeBanner(_ game: LobbyGameView) -> some View {
        let code = GameJoinCode.displayCode(from: game.id)

        return HStack(spacing: 14) {
            Image(systemName: "number")
                .font(.title2.weight(.bold))
                .foregroundStyle(HealthRiskTheme.accent)
                .frame(width: 44, height: 44)
                .background(HealthRiskTheme.accent.opacity(0.16))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            VStack(alignment: .leading, spacing: 2) {
                Text("GAME CODE")
                    .font(.caption2.bold())
                    .tracking(1.2)
                    .foregroundStyle(HealthRiskTheme.muted)
                Text(code)
                    .font(.system(size: 30, weight: .black, design: .monospaced))
                    .tracking(4)
                    .foregroundStyle(HealthRiskTheme.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .textSelection(.enabled)
                    .accessibilityLabel("Game code \(code)")
                Text("Share this six-character code so others can join.")
                    .font(.caption)
                    .foregroundStyle(HealthRiskTheme.muted)
            }

            Spacer(minLength: 12)

            Button {
                UIPasteboard.general.string = code
                didCopyGameCode = true
                Task {
                    try? await Task.sleep(for: .seconds(2))
                    didCopyGameCode = false
                }
            } label: {
                Label(
                    didCopyGameCode ? "Copied" : "Copy",
                    systemImage: didCopyGameCode ? "checkmark" : "doc.on.doc"
                )
                .font(.subheadline.weight(.semibold))
                .frame(height: 36)
            }
            .buttonStyle(.borderedProminent)
            .tint(didCopyGameCode ? HealthRiskTheme.success : HealthRiskTheme.accent)
        }
        .padding(14)
        .background(HealthRiskTheme.accent.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(HealthRiskTheme.accent.opacity(0.5), lineWidth: 1)
        }
    }

    private func healthGoals(_ game: LobbyGameView) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Health Goals")
                        .font(.title2.bold())
                    Text("Choose the goals you would use. Everyone reviews changes before the game starts.")
                        .font(.caption)
                        .foregroundStyle(HealthRiskTheme.muted)
                }
                Spacer(minLength: 10)
                if game.isCreator {
                    Button("Edit") {
                        store.clearRulesError()
                        isEditingRules = true
                    }
                    .buttonStyle(.bordered)
                    .tint(HealthRiskTheme.accent)
                }
            }

            ForEach(game.exercises) { goal in
                healthGoalRow(goal, game: game)
            }

            capsSummary(game)

            if let error = store.choicesError {
                ServerErrorView(error: error)
            }

            if game.lobbyHealthVoting.enabled {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("\(game.lobbyHealthVoting.submissionCount)/\(game.lobbyHealthVoting.requiredSubmissions) players submitted")
                            .font(.caption)
                            .foregroundStyle(HealthRiskTheme.muted)
                        Spacer()
                        if game.lobbyHealthVoting.allSubmitted {
                            Label("Ready", systemImage: "checkmark.circle.fill")
                                .font(.caption.bold())
                                .foregroundStyle(HealthRiskTheme.success)
                        }
                    }

                    Button {
                        Task {
                            _ = await store.submitChoices()
                            await invalidateIfUnauthorized(store.choicesError)
                        }
                    } label: {
                        HStack(spacing: 9) {
                            if store.isSubmittingChoices {
                                ProgressView().tint(.white)
                            }
                            Text(choiceButtonTitle(game))
                                .fontWeight(.bold)
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 46)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(HealthRiskTheme.accent)
                    .disabled(
                        store.isSubmittingChoices ||
                        (game.lobbyHealthVoting.hasSubmitted && !store.choicesHaveChanges)
                    )
                }
                .padding(.top, 3)
            }
        }
    }

    private func healthGoalRow(_ goal: HealthGoalRule, game: LobbyGameView) -> some View {
        let selected = store.selectedGoalKeys.contains(goal.key)
        let interested = game.lobbyHealthVoting.voteCounts[goal.key] ?? 0

        return VStack(alignment: .leading, spacing: 11) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: categoryIcon(goal.category))
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(HealthRiskTheme.accent)
                    .frame(width: 40, height: 40)
                    .background(HealthRiskTheme.accent.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))

                VStack(alignment: .leading, spacing: 4) {
                    Text(goal.label)
                        .font(.headline)
                    Text(goalDescription(goal))
                        .font(.caption)
                        .foregroundStyle(HealthRiskTheme.muted)
                    Text("\(interested) interested")
                        .font(.caption2)
                        .foregroundStyle(interested > 0 ? HealthRiskTheme.success : HealthRiskTheme.muted)
                }
                Spacer()
            }

            if game.lobbyHealthVoting.enabled {
                Button {
                    store.toggleGoal(goal.key)
                } label: {
                    Label("I’d use this", systemImage: selected ? "checkmark.circle.fill" : "circle")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 38)
                }
                .buttonStyle(.bordered)
                .tint(selected ? HealthRiskTheme.success : HealthRiskTheme.accent)
                .accessibilityValue(selected ? "Selected" : "Not selected")
            }
        }
        .padding(16)
        .healthRiskSurface()
    }

    private func capsSummary(_ game: LobbyGameView) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Daily reinforcement limits")
                .font(.subheadline.weight(.semibold))
            ForEach(HealthCategory.allCases) { category in
                if let cap = game.categoryTroopCaps[category.rawValue] {
                    Text("\(category.rawValue.capitalized): up to \(number(cap)) troops")
                        .font(.caption)
                        .foregroundStyle(HealthRiskTheme.muted)
                }
            }
            Text("Overall: up to \(number(game.dailyTotalTroopCap)) troops per day")
                .font(.caption)
                .foregroundStyle(HealthRiskTheme.muted)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HealthRiskTheme.raisedPanel)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func choiceButtonTitle(_ game: LobbyGameView) -> String {
        if store.isSubmittingChoices { return "Submitting…" }
        if game.lobbyHealthVoting.hasSubmitted {
            return store.choicesHaveChanges ? "Update My Choices" : "Choices Submitted"
        }
        return "Submit My Choices"
    }

    private func categoryIcon(_ category: HealthCategory) -> String {
        switch category {
        case .movement: "figure.run"
        case .nutrition: "leaf.fill"
        case .recovery: "moon.zzz.fill"
        }
    }

    private func goalDescription(_ goal: HealthGoalRule) -> String {
        if goal.trackingType == .checkbox {
            return "\(number(goal.troopsPerUnit)) troops when completed · once daily"
        }
        let limit = goal.dailyUnitCap.map { "up to \(number($0)) \(goal.unitLabel) per day" }
            ?? "no individual daily limit"
        return "\(number(goal.troopsPerUnit)) troops per \(goal.unitLabel) · \(limit)"
    }

    private func number(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...3)))
    }

    private func load() async {
        await store.load()
        await invalidateIfUnauthorized(store.error)
        if store.game?.status == .active {
            await enterGameplay()
        }
    }

    private func synchronizeLobby() async {
        await store.synchronize()
        await invalidateIfUnauthorized(store.error)
        if store.game?.status == .active {
            await enterGameplay()
        }
    }

    private func exitLobby() async {
        if await store.exitLobby() {
            await onLobbyExited()
            dismiss()
        } else {
            await invalidateIfUnauthorized(store.exitError)
        }
    }

    private func startGame() async {
        if await store.startGame() {
            await enterGameplay()
        } else {
            await invalidateIfUnauthorized(store.startError)
        }
    }

    private func enterGameplay() async {
        guard !isEnteringGameplay else { return }
        isEnteringGameplay = true
        await onGameStarted(store.gameId)
    }

    private func invalidateIfUnauthorized(_ error: APIError?) async {
        if error?.isUnauthorized == true {
            await authenticationStore.invalidateSession()
        }
    }
}
