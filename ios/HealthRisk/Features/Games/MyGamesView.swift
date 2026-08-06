import SwiftUI
import UIKit

private enum GameRoute: Hashable {
    case waitingRoom(gameId: String, inviteURL: URL?)
    case gameplay(String)
}

struct MyGamesView: View {
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject private var authenticationStore: AuthenticationStore
    @StateObject private var gamesStore: GamesStore
    @State private var isPresentingCreateGame = false
    @State private var isPresentingJoinGame = false
    @State private var navigationPath: [GameRoute] = []
    private let api: any HealthRiskAPI
    private let apiBaseURL: URL

    init(
        api: any HealthRiskAPI,
        apiBaseURL: URL,
        authenticationStore: AuthenticationStore
    ) {
        self.authenticationStore = authenticationStore
        self.api = api
        self.apiBaseURL = apiBaseURL
        _gamesStore = StateObject(wrappedValue: GamesStore(api: api))
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            ZStack {
                HealthRiskTheme.appBackground
                content
            }
            .navigationTitle("My Games")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if case let .signedIn(user) = authenticationStore.state {
                        Label(user.username, systemImage: "person.crop.circle.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(HealthRiskTheme.muted)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            presentCreateGame()
                        } label: {
                            Label("Create a Game", systemImage: "plus.circle")
                        }

                        Button {
                            presentJoinGame()
                        } label: {
                            Label("Join with Code", systemImage: "person.badge.plus")
                        }
                    } label: {
                        Label("Add Game", systemImage: "plus")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Log Out") {
                        Task { await authenticationStore.signOut() }
                    }
                    .disabled(authenticationStore.isSubmitting)
                }
            }
            .navigationDestination(for: GameRoute.self) { route in
                switch route {
                case let .waitingRoom(gameId, inviteURL):
                    WaitingRoomView(
                        gameId: gameId,
                        inviteURL: inviteURL,
                        api: api,
                        authenticationStore: authenticationStore,
                        onLobbyExited: {
                            await gamesStore.load()
                        },
                        onGameStarted: { gameId in
                            await showGameplay(gameId)
                        }
                    )
                case let .gameplay(gameId):
                    GameplayView(
                        gameId: gameId,
                        api: api,
                        authenticationStore: authenticationStore,
                        onGameChanged: {
                            await gamesStore.load()
                        }
                    )
                }
            }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await synchronizeGames()
        }
        .sheet(isPresented: $isPresentingCreateGame) {
            CreateGameView(store: gamesStore) { request in
                let created = await gamesStore.createGame(request)
                if gamesStore.createError?.isUnauthorized == true {
                    await authenticationStore.invalidateSession()
                }
                return created
            }
        }
        .sheet(isPresented: $isPresentingJoinGame) {
            JoinGameView(store: gamesStore) { gameId in
                let joined = await gamesStore.joinGame(gameId: gameId)
                if gamesStore.joinError?.isUnauthorized == true {
                    await authenticationStore.invalidateSession()
                }
                return joined
            }
        }
        .foregroundStyle(HealthRiskTheme.text)
    }

    @ViewBuilder
    private var content: some View {
        if gamesStore.isLoading && gamesStore.games.isEmpty {
            ProgressView("Loading games…")
                .tint(HealthRiskTheme.accent)
                .foregroundStyle(HealthRiskTheme.text)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if let error = gamesStore.error {
                        ServerErrorView(error: error)
                    }

                    if gamesStore.games.isEmpty && gamesStore.error == nil {
                        emptyState
                    } else {
                        gameSection(
                            title: "In Progress",
                            subtitle: "Active turns and waiting rooms",
                            games: gamesStore.games(with: [.active, .setup])
                        )
                        gameSection(
                            title: "History",
                            subtitle: "Finished and cancelled campaigns",
                            games: gamesStore.games(with: [.finished, .cancelled])
                        )
                    }
                }
                .padding(18)
            }
            .refreshable { await loadGames() }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 15) {
            Image(systemName: "map.fill")
                .font(.system(size: 36))
                .foregroundStyle(HealthRiskTheme.accent)
            Text("No games yet")
                .font(.title2.bold())
            Text("Games you create or join will appear here. Gameplay always loads from the authoritative server.")
                .font(.subheadline)
                .foregroundStyle(HealthRiskTheme.muted)
                .multilineTextAlignment(.center)

            Button {
                presentCreateGame()
            } label: {
                Label("Create a Game", systemImage: "plus")
                    .fontWeight(.bold)
                    .frame(maxWidth: .infinity)
                    .frame(height: 46)
            }
            .buttonStyle(.borderedProminent)
            .tint(HealthRiskTheme.accent)
            .padding(.top, 6)

            Button {
                presentJoinGame()
            } label: {
                Label("Join with Code", systemImage: "person.badge.plus")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .frame(height: 42)
            }
            .buttonStyle(.bordered)
            .tint(HealthRiskTheme.accent)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 54)
        .padding(.horizontal, 24)
        .healthRiskSurface()
    }

    @ViewBuilder
    private func gameSection(title: String, subtitle: String, games: [GameSummary]) -> some View {
        if !games.isEmpty {
            VStack(alignment: .leading, spacing: 11) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(HealthRiskTheme.muted)
                }

                ForEach(games) { game in
                    GameSummaryCard(game: game, apiBaseURL: apiBaseURL)
                }
            }
        }
    }

    private func loadGames() async {
        await gamesStore.load()
        if gamesStore.error?.isUnauthorized == true {
            await authenticationStore.invalidateSession()
        }
    }

    private func synchronizeGames() async {
        await gamesStore.synchronize()
        if gamesStore.error?.isUnauthorized == true {
            await authenticationStore.invalidateSession()
        }
    }

    private func showGameplay(_ gameId: String) async {
        var updatedPath = navigationPath
        if !updatedPath.isEmpty {
            updatedPath.removeLast()
        }
        updatedPath.append(.gameplay(gameId))
        navigationPath = updatedPath
        await loadGames()
    }

    private func presentCreateGame() {
        gamesStore.clearCreateError()
        isPresentingCreateGame = true
    }

    private func presentJoinGame() {
        gamesStore.clearJoinError()
        isPresentingJoinGame = true
    }
}

private struct GameSummaryCard: View {
    let game: GameSummary
    let apiBaseURL: URL
    @State private var didCopyInvite = false

    private var statusLabel: String {
        switch game.status {
        case .setup: "Waiting"
        case .active: game.yourTurn ? "Your turn" : "Active"
        case .finished: "Complete"
        case .cancelled: "Cancelled"
        }
    }

    private var statusColor: Color {
        switch game.status {
        case .active: game.yourTurn ? HealthRiskTheme.success : HealthRiskTheme.accent
        case .setup: HealthRiskTheme.accent
        case .finished: HealthRiskTheme.success
        case .cancelled: HealthRiskTheme.muted
        }
    }

    private var inviteURL: URL? {
        game.resolvedInviteURL(relativeTo: apiBaseURL)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: game.practice ? "person.fill" : "person.3.fill")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(statusColor)
                    .frame(width: 42, height: 42)
                    .background(statusColor.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                VStack(alignment: .leading, spacing: 4) {
                    Text(game.practice ? "Practice Campaign" : "Multiplayer Campaign")
                        .font(.headline)
                    Text(game.playerNames.isEmpty ? "Waiting for players" : game.playerNames.joined(separator: " • "))
                        .font(.caption)
                        .foregroundStyle(HealthRiskTheme.muted)
                        .lineLimit(2)
                }

                Spacer(minLength: 8)

                Text(statusLabel)
                    .font(.caption2.bold())
                    .foregroundStyle(statusColor)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(statusColor.opacity(0.12))
                    .clipShape(Capsule())
            }

            HStack(spacing: 16) {
                Label("\(game.playerCount)/\(game.lobbyCapacity)", systemImage: "person.2")
                Label("Day \(game.dayNumber)", systemImage: "sun.max")
                if game.isCreator {
                    Label("Creator", systemImage: "crown")
                }
            }
            .font(.caption)
            .foregroundStyle(HealthRiskTheme.muted)

            if game.status == .setup,
               !game.practice,
               let inviteURL {
                NavigationLink(
                    value: GameRoute.waitingRoom(gameId: game.id, inviteURL: inviteURL)
                ) {
                    Label("Open Waiting Room", systemImage: "person.3.sequence.fill")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 40)
                }
                .buttonStyle(.borderedProminent)
                .tint(HealthRiskTheme.accent)

                HStack(spacing: 10) {
                    ShareLink(
                        item: inviteURL,
                        subject: Text("Join my HealthRisk game"),
                        message: Text("Join my HealthRisk game: \(inviteURL.absoluteString)")
                    ) {
                        Label("Text or Share", systemImage: "message.fill")
                            .frame(maxWidth: .infinity)
                            .frame(height: 38)
                    }

                    Button {
                        UIPasteboard.general.url = inviteURL
                        didCopyInvite = true
                        Task {
                            try? await Task.sleep(for: .seconds(2))
                            didCopyInvite = false
                        }
                    } label: {
                        Label(
                            didCopyInvite ? "Copied" : "Copy Link",
                            systemImage: didCopyInvite ? "checkmark" : "doc.on.doc"
                        )
                        .frame(maxWidth: .infinity)
                        .frame(height: 38)
                    }
                }
                .buttonStyle(.bordered)
                .tint(HealthRiskTheme.accent)
            }

            if game.status == .active {
                NavigationLink(value: GameRoute.gameplay(game.id)) {
                    Label(
                        game.yourTurn ? "Play Your Turn" : "Open Campaign",
                        systemImage: game.yourTurn ? "play.fill" : "map.fill"
                    )
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .frame(height: 40)
                }
                .buttonStyle(.borderedProminent)
                .tint(game.yourTurn ? HealthRiskTheme.success : HealthRiskTheme.accent)
            }

            Text("Game \(game.id)")
                .font(.caption2.monospaced())
                .foregroundStyle(HealthRiskTheme.muted.opacity(0.75))
                .lineLimit(1)
        }
        .padding(16)
        .healthRiskSurface()
        .accessibilityElement(children: .combine)
    }
}
