import SwiftUI

enum GameplayActionMode: String, CaseIterable, Identifiable {
    case attack = "Attack"
    case fortify = "Move"

    var id: String { rawValue }
}

struct AttackRiskPolicy: Equatable {
    static func committedTroops(sourceArmies: Int) -> Int {
        max(1, sourceArmies - 1)
    }

    static func stopLoss(
        committedTroops: Int,
        limitsLosses: Bool,
        selectedLimit: Int
    ) -> Int {
        guard limitsLosses else { return committedTroops }
        return min(committedTroops, max(1, selectedLimit))
    }
}

struct GameplaySelectionGuide: Equatable {
    let sourceIds: Set<String>
    let targetIds: Set<String>
    let selectedSourceId: String?

    var actionableIds: Set<String> {
        guard let selectedSourceId else { return sourceIds }
        return targetIds.union([selectedSourceId])
    }

    static func make(
        game: GameplayGame,
        selectedSourceId: String?,
        mode: GameplayActionMode
    ) -> GameplaySelectionGuide {
        guard
            game.status == .active,
            game.yourTurn,
            let currentPlayerId = game.currentPlayerId
        else {
            return GameplaySelectionGuide(sourceIds: [], targetIds: [], selectedSourceId: nil)
        }

        let territoriesById = Dictionary(uniqueKeysWithValues: game.territories.map { ($0.id, $0) })
        let owned = game.territories.filter { $0.owner == currentPlayerId }

        switch game.phase {
        case .reinforce:
            return GameplaySelectionGuide(
                sourceIds: Set(owned.map(\.id)),
                targetIds: [],
                selectedSourceId: nil
            )
        case .attack:
            let sourceIds = Set(owned.filter { $0.armies > 1 }.map(\.id))
            guard
                let selectedSourceId,
                sourceIds.contains(selectedSourceId),
                let source = territoriesById[selectedSourceId]
            else {
                return GameplaySelectionGuide(
                    sourceIds: sourceIds,
                    targetIds: [],
                    selectedSourceId: nil
                )
            }

            let targetIds: Set<String>
            switch mode {
            case .attack:
                targetIds = Set(source.neighbors.compactMap { neighborId in
                    guard territoriesById[neighborId]?.owner != currentPlayerId else { return nil }
                    return neighborId
                })
            case .fortify:
                // This is guidance only. The server remains authoritative for
                // ownership-path connectivity and validates the mutation.
                targetIds = Set(owned.lazy.map(\.id).filter { $0 != selectedSourceId })
            }

            return GameplaySelectionGuide(
                sourceIds: sourceIds,
                targetIds: targetIds,
                selectedSourceId: selectedSourceId
            )
        case .fortify, .done:
            return GameplaySelectionGuide(sourceIds: [], targetIds: [], selectedSourceId: nil)
        }
    }
}

struct GameplayView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject private var authenticationStore: AuthenticationStore
    @StateObject private var store: GameplayStore
    @State private var selectedSourceId: String?
    @State private var selectedTargetId: String?
    @State private var inspectedTerritoryId: String?
    @State private var troopCount = 1
    @State private var stopLoss = 1
    @State private var limitsAttackLosses = false
    @State private var actionMode: GameplayActionMode = .attack
    @State private var isConfirmingEndTurn = false
    @State private var isShowingCommandPanel = false
    @State private var hasDismissedGameResult = false
    @State private var selectedHealthGoalKey: String?
    @State private var healthUnitsText = "1"
    private let onGameChanged: @MainActor () async -> Void

    init(
        gameId: String,
        api: any HealthRiskAPI,
        authenticationStore: AuthenticationStore,
        onGameChanged: @escaping @MainActor () async -> Void
    ) {
        self.authenticationStore = authenticationStore
        self.onGameChanged = onGameChanged
        _store = StateObject(wrappedValue: GameplayStore(gameId: gameId, api: api))
    }

    var body: some View {
        return ZStack {
            HealthRiskTheme.appBackground
            content

            if let completion = store.lastTurnCompletion,
               store.game?.status != .finished {
                turnCompletionOverlay(completion)
            }

            if let game = store.game,
               let completion = GameCompletionPresentation(game: game),
               !hasDismissedGameResult {
                gameCompletionOverlay(completion)
            }
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .onAppear { AppOrientation.enterGameplay() }
        .onDisappear { AppOrientation.leaveGameplay() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await store.synchronize()
        }
        .confirmationDialog(
            "End your turn?",
            isPresented: $isConfirmingEndTurn,
            titleVisibility: .visible
        ) {
            Button("End Turn") {
                Task { await performEndTurn() }
            }
            Button("Keep Playing", role: .cancel) {}
        } message: {
            Text("The server will advance play to the next person. You cannot add more actions to this turn afterward.")
        }
        .alert(
            battleResultTitle,
            isPresented: Binding(
                get: { store.lastAttackResult != nil },
                set: { isPresented in
                    if !isPresented {
                        store.clearAttackResult()
                    }
                }
            )
        ) {
            Button("Continue") {
                store.clearAttackResult()
            }
        } message: {
            Text(battleResultMessage)
        }
        .onChange(of: actionMode) { _, _ in resetSelection() }
        .onChange(of: store.game?.revision) { oldRevision, newRevision in
            guard newRevision != nil, oldRevision != newRevision else { return }
            resetSelection()
        }
        .onChange(of: store.game?.status) { _, status in
            if status == .finished {
                hasDismissedGameResult = false
            }
        }
        .onChange(of: store.error) { _, error in
            guard error?.isUnauthorized == true else { return }
            Task { await authenticationStore.invalidateSession() }
        }
        .alert(
            "Cards Traded",
            isPresented: Binding(
                get: { store.lastCardTrade != nil },
                set: { if !$0 { store.clearCardTrade() } }
            )
        ) {
            Button("Continue") { store.clearCardTrade() }
        } message: {
            if let trade = store.lastCardTrade {
                Text("You received \(trade.troopsAwarded) reinforcements and have \(trade.remainingCards) conquest cards remaining.")
            }
        }
        .alert(
            "Health Progress Saved",
            isPresented: Binding(
                get: { store.lastExerciseLog != nil },
                set: { if !$0 { store.clearExerciseLog() } }
            )
        ) {
            Button("Continue") { store.clearExerciseLog() }
        } message: {
            Text(exerciseLogMessage)
        }
        .foregroundStyle(HealthRiskTheme.text)
    }

    @ViewBuilder
    private var content: some View {
        if store.isLoading && store.game == nil {
            ProgressView("Loading campaign…")
                .tint(HealthRiskTheme.accent)
        } else if let game = store.game {
            GeometryReader { proxy in
                if proxy.size.width > proxy.size.height {
                    fullScreenCampaign(game, size: proxy.size)
                } else {
                    rotationPlaceholder
                }
            }
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

    private func fullScreenCampaign(_ game: GameplayGame, size: CGSize) -> some View {
        let guide = GameplaySelectionGuide.make(
            game: game,
            selectedSourceId: selectedSourceId,
            mode: actionMode
        )
        let showsInlineActionTray = game.yourTurn && game.status == .active
        return ZStack {
            TerritoryBoardView(
                territories: game.territories,
                guide: guide,
                selectedSourceId: selectedSourceId,
                selectedTargetId: selectedTargetId,
                inspectedTerritoryId: inspectedTerritoryId,
                showsActionGuidance: game.yourTurn && game.status == .active && (game.phase == .reinforce || game.phase == .attack),
                onSelect: selectTerritory
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(HealthRiskTheme.background)

            VStack {
                campaignHUD(
                    game,
                    showsDeadline: size.width > 1_050,
                    showsInlineActions: showsInlineActionTray
                )
                Spacer()
                if !game.yourTurn, let selected = selectedTerritory(in: game) {
                    selectionPill(selected, game: game)
                }
            }

            if isShowingCommandPanel {
                Color.black.opacity(0.28)
                    .ignoresSafeArea()
                    .onTapGesture {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            isShowingCommandPanel = false
                        }
                    }

                HStack {
                    Spacer()
                    commandPanel(game, width: min(370, max(310, size.width * 0.42)))
                }
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: isShowingCommandPanel)
        .ignoresSafeArea()
    }

    private var rotationPlaceholder: some View {
        VStack(spacing: 14) {
            Image(systemName: "iphone.landscape")
                .font(.system(size: 36))
                .foregroundStyle(HealthRiskTheme.accent)
            Text("Rotating campaign…")
                .font(.headline)
            Text("Gameplay uses a landscape strategy board.")
                .font(.subheadline)
                .foregroundStyle(HealthRiskTheme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func campaignHUD(
        _ game: GameplayGame,
        showsDeadline: Bool,
        showsInlineActions: Bool
    ) -> some View {
        HStack(spacing: 9) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "chevron.left")
                    .font(.headline)
                    .frame(width: 42, height: 42)
            }
            .buttonStyle(.plain)
            .background(.ultraThinMaterial)
            .clipShape(Circle())

            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Campaign · Day \(game.dayNumber)")
                        .font(.subheadline.weight(.bold))
                    Text(turnMessage(game, includesPhase: false))
                        .font(.caption2)
                        .foregroundStyle(game.yourTurn ? HealthRiskTheme.success : HealthRiskTheme.muted)
                        .lineLimit(1)
                }
                if let current = game.currentPlayer {
                    Label("\(current.pendingReinforcements)", systemImage: "shield.lefthalf.filled")
                        .font(.caption2)
                        .foregroundStyle(HealthRiskTheme.muted)
                }
                if let cards = game.dashboard?.cards {
                    Label("\(cards.hand.count)", systemImage: "rectangle.stack.fill")
                        .font(.caption2)
                        .foregroundStyle(cards.canTrade ? HealthRiskTheme.success : HealthRiskTheme.muted)
                        .accessibilityLabel("\(cards.hand.count) conquest cards")
                }
                if showsDeadline, let deadline = formattedDate(game.windowExpiresAt) {
                    Label(deadline, systemImage: "clock")
                        .font(.caption2)
                        .foregroundStyle(HealthRiskTheme.muted)
                        .lineLimit(1)
                } else if showsDeadline, let nextSession = formattedDate(game.nextSessionOpensAt) {
                    Label(nextSession, systemImage: "calendar")
                        .font(.caption2)
                        .foregroundStyle(HealthRiskTheme.muted)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 13)
            .frame(height: 42)
            .background(.ultraThinMaterial)
            .clipShape(Capsule())

            Spacer(minLength: 6)

            if showsInlineActions {
                inlineActionTray(game)
            }

            Spacer(minLength: 6)

            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isShowingCommandPanel = true
                }
            } label: {
                Label(game.yourTurn ? "Controls" : "Game Info", systemImage: "slider.horizontal.3")
                    .font(.caption.weight(.bold))
                    .frame(height: 42)
                    .padding(.horizontal, 12)
            }
            .buttonStyle(.plain)
            .foregroundStyle(game.yourTurn ? HealthRiskTheme.success : HealthRiskTheme.text)
            .background(.ultraThinMaterial)
            .clipShape(Capsule())

            Button {
                Task { await load() }
            } label: {
                if store.isLoading || store.isRefreshing {
                    ProgressView()
                        .tint(HealthRiskTheme.text)
                        .frame(width: 42, height: 42)
                } else {
                    Image(systemName: "arrow.clockwise")
                        .font(.headline)
                        .frame(width: 42, height: 42)
                }
            }
            .buttonStyle(.plain)
            .background(.ultraThinMaterial)
            .clipShape(Circle())
            .disabled(store.isLoading || store.isRefreshing || store.isPerformingAction)
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
    }

    private func playerSidebar(_ game: GameplayGame) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text("Players")
                    .font(.headline)
                Spacer()
                Text("\(game.players.count)")
                    .font(.caption.bold())
                    .foregroundStyle(HealthRiskTheme.muted)
            }

            ForEach(game.players) { player in
                let territoryCount = game.territories.filter { $0.owner == player.id }.count
                HStack(spacing: 9) {
                    Circle()
                        .fill(Color(hex: player.color) ?? HealthRiskTheme.muted)
                        .frame(width: 12, height: 12)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(player.name)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                        if player.id == game.currentPlayerId {
                            Text(game.mySeats.contains(player.id) ? "Your turn" : "Current turn")
                                .font(.caption2.bold())
                                .foregroundStyle(HealthRiskTheme.success)
                        }
                    }
                    Spacer()
                    Text("\(territoryCount) land · \(player.pendingReinforcements) banked")
                        .font(.caption2)
                        .foregroundStyle(HealthRiskTheme.muted)
                        .lineLimit(1)
                }
                .padding(.vertical, 4)
            }
        }
        .padding(14)
        .healthRiskSurface()
    }

    private func selectionPill(_ territory: GameplayTerritory, game: GameplayGame) -> some View {
        let owner = game.players.first { $0.id == territory.owner }
        return HStack(spacing: 10) {
            Circle()
                .fill(Color(hex: territory.color) ?? HealthRiskTheme.muted)
                .frame(width: 13, height: 13)
            Text(pretty(territory.id))
                .font(.subheadline.weight(.bold))
            Text("\(territory.armies) armies · \(owner?.name ?? "Neutral")")
                .font(.caption)
                .foregroundStyle(HealthRiskTheme.muted)
            if selectedSourceId != nil {
                Text(selectionLabel)
                    .font(.caption2)
                    .foregroundStyle(HealthRiskTheme.accent)
                    .lineLimit(1)
            }
            Button(game.yourTurn ? "Open Controls" : "Details") {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isShowingCommandPanel = true
                }
            }
            .font(.caption.weight(.bold))
            .buttonStyle(.borderedProminent)
            .tint(HealthRiskTheme.accent)
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .background(.ultraThinMaterial)
        .clipShape(Capsule())
        .shadow(color: .black.opacity(0.35), radius: 10)
        .padding(.bottom, 8)
    }

    @ViewBuilder
    private func inlineActionTray(_ game: GameplayGame) -> some View {
        HStack(spacing: 5) {
            switch game.phase {
            case .reinforce:
                Label(selectedSourceId.map(pretty) ?? "Choose land", systemImage: "shield.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HealthRiskTheme.accent)
                    .lineLimit(1)
                    .frame(maxWidth: 100)

                inlineCountControl(
                    maximum: max(1, game.currentPlayerReinforcements),
                    accessibilityVerb: "troops to place"
                )

                Button {
                    guard let selectedSourceId else { return }
                    Task { await performReinforcement(territoryId: selectedSourceId) }
                } label: {
                    inlineActionLabel("Place")
                }
                .buttonStyle(.borderedProminent)
                .tint(HealthRiskTheme.accent)
                .disabled(selectedSourceId == nil || store.isPerformingAction)

            case .attack:
                Picker("Action mode", selection: $actionMode) {
                    ForEach(GameplayActionMode.allCases) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .tint(HealthRiskTheme.accent)
                .frame(width: 126, height: 38)
                .accessibilityLabel("Action mode")

                Text(inlineSelectionLabel)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(HealthRiskTheme.muted)
                    .lineLimit(1)
                    .frame(maxWidth: 92)

                if selectedSourceId != nil {
                    if actionMode == .attack {
                        inlineAttackRiskControl(
                            maximum: AttackRiskPolicy.committedTroops(
                                sourceArmies: sourceTerritory(in: game)?.armies ?? 2
                            )
                        )
                    } else {
                        inlineCountControl(
                            maximum: max(1, (sourceTerritory(in: game)?.armies ?? 2) - 1),
                            accessibilityVerb: "troops to move"
                        )
                    }
                }

                Button {
                    Task { await performSelectedAction() }
                } label: {
                    inlinePrimaryActionLabel(game)
                }
                .buttonStyle(.plain)
                .foregroundStyle(
                    canPerformSelectedAction ? HealthRiskTheme.background : HealthRiskTheme.muted
                )
                .background(
                    canPerformSelectedAction ? HealthRiskTheme.accent : HealthRiskTheme.raisedPanel
                )
                .clipShape(Capsule())
                .overlay {
                    Capsule()
                        .stroke(
                            canPerformSelectedAction ? HealthRiskTheme.accent : HealthRiskTheme.line,
                            lineWidth: 1
                        )
                }
                .disabled(!canPerformSelectedAction || store.isPerformingAction)
                .accessibilityLabel(inlinePrimaryActionTitle(game))

            case .fortify:
                Label("Troops moved", systemImage: "checkmark.circle.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HealthRiskTheme.success)
                Button {
                    isConfirmingEndTurn = true
                } label: {
                    inlineActionLabel("End Turn")
                }
                .buttonStyle(.borderedProminent)
                .tint(HealthRiskTheme.accent)
                .disabled(store.isPerformingAction)

            case .done:
                Label("Turn complete", systemImage: "checkmark.circle.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HealthRiskTheme.success)
            }
        }
        .padding(3)
        .background(.ultraThinMaterial)
        .clipShape(Capsule())
        .overlay {
            Capsule()
                .stroke(store.actionError == nil ? HealthRiskTheme.line : HealthRiskTheme.danger, lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.3), radius: 8)
        .fixedSize(horizontal: true, vertical: false)
    }

    private func inlineCountControl(maximum: Int, accessibilityVerb: String) -> some View {
        HStack(spacing: 0) {
            Button {
                troopCount = max(1, troopCount - 1)
                stopLoss = min(stopLoss, troopCount)
            } label: {
                Image(systemName: "minus")
                    .font(.caption.weight(.bold))
                    .frame(width: 38, height: 38)
            }
            .buttonStyle(.plain)
            .disabled(troopCount <= 1)

            Text("\(min(troopCount, maximum))")
                .font(.caption.monospacedDigit().weight(.bold))
                .frame(minWidth: 20)
                .accessibilityLabel("\(troopCount) \(accessibilityVerb)")

            Button {
                troopCount = min(maximum, troopCount + 1)
            } label: {
                Image(systemName: "plus")
                    .font(.caption.weight(.bold))
                    .frame(width: 38, height: 38)
            }
            .buttonStyle(.plain)
            .disabled(troopCount >= maximum)
        }
        .background(HealthRiskTheme.raisedPanel)
        .clipShape(Capsule())
    }

    private func inlineAttackRiskControl(maximum: Int) -> some View {
        HStack(spacing: 0) {
            Menu {
                Button {
                    limitsAttackLosses = false
                    stopLoss = maximum
                } label: {
                    Label("All in — attack until captured", systemImage: "flame.fill")
                }

                Button {
                    limitsAttackLosses = true
                    stopLoss = min(maximum, max(1, stopLoss))
                } label: {
                    Label("Limit my losses", systemImage: "hand.raised.fill")
                }
            } label: {
                HStack(spacing: 5) {
                    Label(
                        limitsAttackLosses ? "Risk \(min(stopLoss, maximum))" : "All in",
                        systemImage: limitsAttackLosses ? "hand.raised.fill" : "flame.fill"
                    )
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(HealthRiskTheme.muted)
                }
                .font(.caption.weight(.bold))
                .frame(minHeight: 38)
                .padding(.horizontal, 9)
            }
            .buttonStyle(.plain)

            if limitsAttackLosses {
                Divider()
                    .frame(height: 24)

                Button {
                    stopLoss = max(1, stopLoss - 1)
                } label: {
                    Image(systemName: "minus")
                        .font(.caption.weight(.bold))
                        .frame(width: 34, height: 38)
                }
                .buttonStyle(.plain)
                .disabled(stopLoss <= 1)

                Button {
                    stopLoss = min(maximum, stopLoss + 1)
                } label: {
                    Image(systemName: "plus")
                        .font(.caption.weight(.bold))
                        .frame(width: 34, height: 38)
                }
                .buttonStyle(.plain)
                .disabled(stopLoss >= maximum)
            }
        }
        .background(HealthRiskTheme.raisedPanel)
        .clipShape(Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            limitsAttackLosses
                ? "Stop after \(min(stopLoss, maximum)) attacker losses"
                : "All in, attack until captured or the attacking force is exhausted"
        )
    }

    private func inlineActionLabel(_ title: String) -> some View {
        HStack(spacing: 5) {
            if store.isPerformingAction {
                ProgressView()
                    .controlSize(.small)
                    .tint(.white)
            }
            Text(store.isPerformingAction ? "Updating…" : title)
                .font(.caption.weight(.bold))
        }
        .padding(.horizontal, 5)
        .frame(minHeight: 38)
    }

    private var canPerformSelectedAction: Bool {
        selectedSourceId != nil && selectedTargetId != nil
    }

    private func inlinePrimaryActionLabel(_ game: GameplayGame) -> some View {
        HStack(spacing: 5) {
            if store.isPerformingAction {
                ProgressView()
                    .controlSize(.small)
                    .tint(HealthRiskTheme.background)
            } else if actionMode == .attack {
                Image(systemName: "figure.fencing")
                    .font(.system(size: 23, weight: .semibold))
            }
            if actionMode == .fortify {
                Text(store.isPerformingAction ? "Updating…" : inlinePrimaryActionTitle(game))
                    .font(.caption.weight(.bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
        }
        .padding(.horizontal, actionMode == .attack ? 0 : 10)
        .frame(
            minWidth: actionMode == .attack ? 54 : 92,
            maxWidth: actionMode == .attack ? 54 : 126,
            minHeight: actionMode == .attack ? 42 : 38
        )
    }

    private func inlinePrimaryActionTitle(_ game: GameplayGame) -> String {
        guard selectedSourceId != nil else { return "Select source" }
        guard let selectedTargetId else { return "Select target" }

        switch actionMode {
        case .attack:
            return "Attack \(pretty(selectedTargetId))"
        case .fortify:
            let maximum = max(1, (sourceTerritory(in: game)?.armies ?? 2) - 1)
            let count = min(troopCount, maximum)
            return "Move \(count) \(count == 1 ? "troop" : "troops")"
        }
    }

    private var inlineSelectionLabel: String {
        if let selectedSourceId, let selectedTargetId {
            return "\(pretty(selectedSourceId)) → \(pretty(selectedTargetId))"
        }
        if let selectedSourceId {
            return "\(pretty(selectedSourceId)) → ?"
        }
        return "Select source"
    }

    private func commandPanel(_ game: GameplayGame, width: CGFloat) -> some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Campaign Controls")
                        .font(.headline)
                    Text(turnMessage(game))
                        .font(.caption)
                        .foregroundStyle(game.yourTurn ? HealthRiskTheme.success : HealthRiskTheme.muted)
                }
                Spacer()
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        isShowingCommandPanel = false
                    }
                } label: {
                    Image(systemName: "xmark")
                        .font(.headline)
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)
                .background(HealthRiskTheme.raisedPanel)
                .clipShape(Circle())
            }
            .padding(14)

            Divider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if let error = store.error {
                        ServerErrorView(error: error)
                    }
                    if game.yourTurn && game.phase != .done {
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                isShowingCommandPanel = false
                            }
                        } label: {
                            Label("Select on Full Map", systemImage: "map.fill")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity)
                                .frame(height: 38)
                        }
                        .buttonStyle(.bordered)
                        .tint(HealthRiskTheme.accent)
                    }
                    actionPanel(game)
                    if let dashboard = game.dashboard {
                        healthGoalsPanel(game, dashboard: dashboard)
                        conquestCardsPanel(game, dashboard: dashboard)
                    }
                    if let selected = selectedTerritory(in: game) {
                        territoryDetails(selected, game: game)
                    } else {
                        inspectionHint
                    }
                    playerSidebar(game)
                }
                .padding(10)
            }
            .scrollIndicators(.visible)
        }
        .frame(width: width)
        .frame(maxHeight: .infinity)
        .background(HealthRiskTheme.appBackground)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(HealthRiskTheme.line, lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.5), radius: 24)
        .padding(8)
    }

    private func territoryDetails(_ territory: GameplayTerritory, game: GameplayGame) -> some View {
        let owner = game.players.first { $0.id == territory.owner }
        return VStack(alignment: .leading, spacing: 9) {
            Text("Selected Territory")
                .font(.caption.bold())
                .foregroundStyle(HealthRiskTheme.muted)
            HStack(alignment: .top, spacing: 10) {
                Circle()
                    .fill(Color(hex: territory.color) ?? HealthRiskTheme.muted)
                    .frame(width: 16, height: 16)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                    Text(pretty(territory.id))
                        .font(.subheadline.weight(.semibold))
                    Text("\(territory.armies) armies · \(owner?.name ?? "Neutral")")
                        .font(.caption)
                        .foregroundStyle(HealthRiskTheme.muted)
                    Text(pretty(territory.continent))
                        .font(.caption2)
                        .foregroundStyle(HealthRiskTheme.accent)
                    Text("Neighbors: \(territory.neighbors.map(pretty).joined(separator: ", "))")
                        .font(.caption2)
                        .foregroundStyle(HealthRiskTheme.muted)
                }
            }
        }
        .padding(14)
        .healthRiskSurface()
    }

    private var inspectionHint: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Inspect the board", systemImage: "scope")
                .font(.subheadline.weight(.semibold))
            Text("Select a territory to see its owner, armies, continent, and neighbors.")
                .font(.caption)
                .foregroundStyle(HealthRiskTheme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .healthRiskSurface()
    }

    @ViewBuilder
    private func actionPanel(_ game: GameplayGame) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(game.status == .finished ? "Campaign Result" : game.yourTurn ? "Your Move" : "Live Campaign")
                .font(.title2.bold())

            if let error = store.actionError {
                ServerErrorView(error: error)
            }

            if game.status == .finished {
                let winner = game.players.first { $0.id == game.winnerId }?.name ?? "A player"
                VStack(alignment: .leading, spacing: 7) {
                    Label("Campaign complete", systemImage: "trophy.fill")
                        .font(.headline)
                        .foregroundStyle(HealthRiskTheme.success)
                    Text("\(winner) won. The final board remains available for inspection.")
                        .font(.subheadline)
                        .foregroundStyle(HealthRiskTheme.muted)
                }
            } else if !game.yourTurn {
                VStack(alignment: .leading, spacing: 7) {
                    Label("Watching for the next move", systemImage: "arrow.triangle.2.circlepath")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HealthRiskTheme.accent)
                    Text("The board updates automatically while this campaign is open. You can keep inspecting territories in the meantime.")
                        .font(.subheadline)
                        .foregroundStyle(HealthRiskTheme.muted)
                }
            } else {
                switch game.phase {
                case .reinforce:
                    reinforcementControls(game)
                case .attack:
                    attackAndFortifyControls(game)
                case .fortify, .done:
                    Text("Your actions are complete. End the turn when you are ready.")
                        .font(.subheadline)
                        .foregroundStyle(HealthRiskTheme.muted)
                }

                if game.phase != .reinforce {
                    Button {
                        isConfirmingEndTurn = true
                    } label: {
                        Label("End Turn", systemImage: "forward.end.fill")
                            .fontWeight(.bold)
                            .frame(maxWidth: .infinity)
                            .frame(height: 46)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(HealthRiskTheme.accent)
                    .disabled(store.isPerformingAction)
                }
            }
        }
        .padding(18)
        .healthRiskSurface()
    }

    private func conquestCardsPanel(
        _ game: GameplayGame,
        dashboard: GameplayDashboard
    ) -> some View {
        let cards = dashboard.cards
        return VStack(alignment: .leading, spacing: 11) {
            HStack {
                Label("Conquest Cards", systemImage: "rectangle.stack.fill")
                    .font(.headline)
                Spacer()
                Text("\(cards.hand.count)/\(cards.tradeSize)")
                    .font(.caption.monospacedDigit().bold())
                    .foregroundStyle(cards.canTrade ? HealthRiskTheme.success : HealthRiskTheme.muted)
            }

            if cards.hand.isEmpty {
                Text("Capture at least one territory during a turn, then finish the turn to earn one card.")
                    .font(.caption)
                    .foregroundStyle(HealthRiskTheme.muted)
            } else {
                ForEach(cards.hand) { card in
                    HStack(spacing: 9) {
                        Image(systemName: "map.fill")
                            .foregroundStyle(HealthRiskTheme.accent)
                        Text(pretty(card.territoryId))
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Text("Day \(card.earnedDay)")
                            .font(.caption2)
                            .foregroundStyle(HealthRiskTheme.muted)
                    }
                    .padding(.vertical, 2)
                }
            }

            if dashboard.turnSummary?.cardPending == true {
                Label("A conquest card will be awarded when you finish this turn.", systemImage: "sparkles")
                    .font(.caption)
                    .foregroundStyle(HealthRiskTheme.success)
            }

            if cards.canTrade {
                Button {
                    Task { await performCardTrade() }
                } label: {
                    Label(
                        "Trade \(cards.tradeSize) for \(cards.tradeReward) troops",
                        systemImage: "arrow.triangle.2.circlepath"
                    )
                    .fontWeight(.bold)
                    .frame(maxWidth: .infinity)
                    .frame(height: 42)
                }
                .buttonStyle(.borderedProminent)
                .tint(HealthRiskTheme.success)
                .disabled(store.isPerformingAction)
            } else if cards.hand.count >= cards.tradeSize {
                Text("Cards can be traded during the reinforcement phase of your turn.")
                    .font(.caption)
                    .foregroundStyle(HealthRiskTheme.muted)
            } else {
                Text("Any \(cards.tradeSize) cards trade for \(cards.tradeReward) reinforcements.")
                    .font(.caption)
                    .foregroundStyle(HealthRiskTheme.muted)
            }
        }
        .padding(14)
        .healthRiskSurface()
    }

    @ViewBuilder
    private func healthGoalsPanel(
        _ game: GameplayGame,
        dashboard: GameplayDashboard
    ) -> some View {
        if let exercise = dashboard.exercise {
            let loggingAllowed = game.healthLogging?.allowed ?? true
            let dailyCapReached = exercise.totalTroops >= exercise.dailyCap

            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    Label("Today’s Health Goals", systemImage: "heart.fill")
                        .font(.headline)
                        .foregroundStyle(HealthRiskTheme.text)
                    Spacer()
                    Text("\(formattedNumber(exercise.totalTroops))/\(formattedNumber(exercise.dailyCap)) troops")
                        .font(.caption.monospacedDigit().bold())
                        .foregroundStyle(dailyCapReached ? HealthRiskTheme.success : HealthRiskTheme.accent)
                }

                ProgressView(value: min(exercise.totalTroops, exercise.dailyCap), total: max(1, exercise.dailyCap))
                    .tint(dailyCapReached ? HealthRiskTheme.success : HealthRiskTheme.accent)

                Text(healthLoggingMessage(game, dashboard: dashboard))
                    .font(.caption)
                    .foregroundStyle(HealthRiskTheme.muted)

                if exercise.totalCapApplied || dailyCapReached {
                    Label("Daily reward limits have been reached or applied.", systemImage: "checkmark.shield.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HealthRiskTheme.success)
                }

                ForEach(exercise.progress) { progress in
                    healthGoalRow(
                        progress,
                        rule: game.exercises?.first { $0.key == progress.key },
                        loggingAllowed: loggingAllowed,
                        dailyCapReached: dailyCapReached
                    )
                }
            }
            .padding(14)
            .healthRiskSurface()
        }
    }

    private func healthGoalRow(
        _ progress: GameplayExerciseProgress,
        rule: HealthGoalRule?,
        loggingAllowed: Bool,
        dailyCapReached: Bool
    ) -> some View {
        let isSelected = selectedHealthGoalKey == progress.key
        let goalCapReached = progress.unitCap.map { progress.countedUnits >= $0 } ?? false

        return VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 10) {
                Image(systemName: healthGoalSymbol(progress.category))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HealthRiskTheme.accent)
                    .frame(width: 30, height: 30)
                    .background(HealthRiskTheme.accent.opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))

                VStack(alignment: .leading, spacing: 2) {
                    Text(progress.label)
                        .font(.subheadline.weight(.semibold))
                    Text(healthGoalProgressText(progress))
                        .font(.caption2)
                        .foregroundStyle(HealthRiskTheme.muted)
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    Text("\(formattedNumber(progress.troopsEarned)) troops")
                        .font(.caption.monospacedDigit().bold())
                        .foregroundStyle(progress.troopsEarned > 0 ? HealthRiskTheme.success : HealthRiskTheme.muted)
                    Image(systemName: isSelected ? "chevron.up" : "chevron.down")
                        .font(.caption2.bold())
                        .foregroundStyle(HealthRiskTheme.muted)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture {
                withAnimation(.easeInOut(duration: 0.18)) {
                    if isSelected {
                        selectedHealthGoalKey = nil
                    } else {
                        selectedHealthGoalKey = progress.key
                        healthUnitsText = "1"
                    }
                }
            }

            if let cap = progress.unitCap {
                ProgressView(value: min(progress.countedUnits, cap), total: max(1, cap))
                    .tint(goalCapReached ? HealthRiskTheme.success : HealthRiskTheme.accent)
            }

            if isSelected {
                Divider()

                if let rule {
                    Text(healthConversionText(rule))
                        .font(.caption)
                        .foregroundStyle(HealthRiskTheme.muted)
                }

                if !loggingAllowed {
                    Text("Health logging is not available for this game or player.")
                        .font(.caption)
                        .foregroundStyle(HealthRiskTheme.danger)
                } else if dailyCapReached || goalCapReached {
                    Label(
                        dailyCapReached ? "Daily troop cap reached" : "This goal’s daily cap is complete",
                        systemImage: "checkmark.circle.fill"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HealthRiskTheme.success)
                } else if progress.trackingType == .checkbox {
                    Button {
                        Task { await performHealthLog(progress: progress, units: 1) }
                    } label: {
                        Label("Mark Complete", systemImage: "checkmark.circle.fill")
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity)
                            .frame(height: 38)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(HealthRiskTheme.success)
                    .disabled(store.isPerformingAction)
                } else {
                    HStack(spacing: 8) {
                        TextField("Amount", text: $healthUnitsText)
                            .keyboardType(.decimalPad)
                            .textFieldStyle(.roundedBorder)
                            .frame(maxWidth: 105)

                        Text(progress.unitLabel)
                            .font(.caption)
                            .foregroundStyle(HealthRiskTheme.muted)

                        Spacer()

                        Button {
                            guard let units = parsedHealthUnits else { return }
                            Task { await performHealthLog(progress: progress, units: units) }
                        } label: {
                            if store.isPerformingAction {
                                ProgressView()
                                    .tint(.white)
                            } else {
                                Text("Log Progress")
                                    .fontWeight(.semibold)
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(HealthRiskTheme.accent)
                        .disabled(parsedHealthUnits == nil || store.isPerformingAction)
                    }
                }
            }
        }
        .padding(11)
        .background(isSelected ? HealthRiskTheme.raisedPanel : HealthRiskTheme.background.opacity(0.45))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(isSelected ? HealthRiskTheme.accent.opacity(0.55) : HealthRiskTheme.line, lineWidth: 1)
        }
    }

    private func reinforcementControls(_ game: GameplayGame) -> some View {
        let bank = max(1, game.currentPlayerReinforcements)
        return VStack(alignment: .leading, spacing: 12) {
            Text("Select one of your territories, then place troops from your reinforcement bank. All troops must be placed before attacking.")
                .font(.subheadline)
                .foregroundStyle(HealthRiskTheme.muted)

            Text(selectedSourceId.map { "Target: \(pretty($0))" } ?? "Tap a territory on the board")
                .font(.subheadline.weight(.semibold))

            Stepper(value: $troopCount, in: 1...bank) {
                Text("Place \(troopCount) \(troopCount == 1 ? "troop" : "troops")")
            }
            .tint(HealthRiskTheme.accent)

            Button {
                guard let selectedSourceId else { return }
                Task { await performReinforcement(territoryId: selectedSourceId) }
            } label: {
                actionButtonLabel("Place Reinforcements", systemImage: "shield.fill")
            }
            .buttonStyle(.borderedProminent)
            .tint(HealthRiskTheme.accent)
            .disabled(selectedSourceId == nil || store.isPerformingAction)
        }
    }

    private func attackAndFortifyControls(_ game: GameplayGame) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Action", selection: $actionMode) {
                ForEach(GameplayActionMode.allCases) { mode in
                    Text(mode.rawValue).tag(mode)
                }
            }
            .pickerStyle(.segmented)

            Text(actionInstruction)
                .font(.subheadline)
                .foregroundStyle(HealthRiskTheme.muted)

            Text(selectionLabel)
                .font(.subheadline.weight(.semibold))

            let maximum = max(1, (sourceTerritory(in: game)?.armies ?? 2) - 1)
            if actionMode == .attack {
                VStack(alignment: .leading, spacing: 9) {
                    Text("Attack with up to \(maximum) \(maximum == 1 ? "troop" : "troops")")
                        .font(.subheadline.weight(.semibold))

                    Picker("Attack risk", selection: $limitsAttackLosses) {
                        Text("All In").tag(false)
                        Text("Limit Losses").tag(true)
                    }
                    .pickerStyle(.segmented)

                    if limitsAttackLosses {
                        Stepper(value: $stopLoss, in: 1...maximum) {
                            Text("Stop after \(stopLoss) \(stopLoss == 1 ? "loss" : "losses")")
                        }
                        .tint(HealthRiskTheme.accent)
                    } else {
                        Text("The server keeps rolling until you capture the territory or the attacking force is exhausted.")
                            .font(.caption)
                            .foregroundStyle(HealthRiskTheme.muted)
                    }
                }
            } else {
                Stepper(value: $troopCount, in: 1...maximum) {
                    Text("Move \(troopCount) \(troopCount == 1 ? "troop" : "troops")")
                }
                .tint(HealthRiskTheme.accent)
            }

            Button {
                Task { await performSelectedAction() }
            } label: {
                actionButtonLabel(
                    actionMode == .attack ? "Resolve Attack" : "Move Troops",
                    systemImage: actionMode == .attack ? "bolt.shield.fill" : "arrow.left.arrow.right"
                )
            }
            .buttonStyle(.borderedProminent)
            .tint(HealthRiskTheme.accent)
            .disabled(selectedSourceId == nil || selectedTargetId == nil || store.isPerformingAction)
        }
    }

    private func actionButtonLabel(_ title: String, systemImage: String) -> some View {
        HStack(spacing: 9) {
            if store.isPerformingAction {
                ProgressView().tint(.white)
            } else {
                Image(systemName: systemImage)
            }
            Text(store.isPerformingAction ? "Updating…" : title)
                .fontWeight(.bold)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 46)
    }

    private var actionInstruction: String {
        switch actionMode {
        case .attack:
            "Tap your territory, then an adjacent target. All In resolves the entire battle in one server-authoritative action; Limit Losses stops after your chosen casualties."
        case .fortify:
            "Tap a source and destination. The server verifies that both are yours and connected through your territory network."
        }
    }

    private var selectionLabel: String {
        if let selectedSourceId, let selectedTargetId {
            return "\(pretty(selectedSourceId)) → \(pretty(selectedTargetId))"
        }
        if let selectedSourceId {
            return "From \(pretty(selectedSourceId)); now tap a destination"
        }
        return "Tap a source territory on the board"
    }

    private func selectTerritory(_ id: String) {
        store.clearActionError()
        guard let game = store.game else { return }
        inspectedTerritoryId = id

        let guide = GameplaySelectionGuide.make(
            game: game,
            selectedSourceId: selectedSourceId,
            mode: actionMode
        )

        if game.phase == .reinforce {
            guard guide.sourceIds.contains(id) else { return }
            selectedSourceId = id
            selectedTargetId = nil
            troopCount = min(max(1, troopCount), max(1, game.currentPlayerReinforcements))
            return
        }

        guard game.phase == .attack else { return }

        if selectedSourceId == nil {
            guard guide.sourceIds.contains(id) else { return }
            selectedSourceId = id
            selectedTargetId = nil
            troopCount = AttackRiskPolicy.committedTroops(
                sourceArmies: game.territories.first { $0.id == id }?.armies ?? 2
            )
            limitsAttackLosses = false
            stopLoss = troopCount
        } else if selectedSourceId == id {
            resetActionSelection()
        } else if guide.targetIds.contains(id) {
            selectedTargetId = id
        }
    }

    private func selectedTerritory(in game: GameplayGame) -> GameplayTerritory? {
        let id = inspectedTerritoryId ?? selectedTargetId ?? selectedSourceId
        return game.territories.first { $0.id == id }
    }

    private func sourceTerritory(in game: GameplayGame) -> GameplayTerritory? {
        game.territories.first { $0.id == selectedSourceId }
    }

    private func turnCompletionOverlay(_ completion: TurnCompletionPresentation) -> some View {
        ZStack {
            Color.black.opacity(0.68)
                .ignoresSafeArea()

            VStack(spacing: 12) {
                HStack(spacing: 11) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 36))
                        .foregroundStyle(HealthRiskTheme.success)

                    VStack(alignment: .leading, spacing: 3) {
                        Text("Turn Complete")
                            .font(.title2.bold())
                        if let nextPlayerName = completion.nextPlayerName {
                            Text("Waiting for \(nextPlayerName)")
                                .font(.caption)
                                .foregroundStyle(HealthRiskTheme.muted)
                        }
                    }

                    Spacer()
                }

                if let summary = completion.summary {
                    HStack(spacing: 8) {
                        turnStat("Placed", value: summary.reinforcementsPlaced)
                        turnStat("Battles", value: summary.attacksMade)
                        turnStat("Captured", value: summary.territoriesCaptured.count)
                        turnStat("Losses", value: summary.attackerLosses)
                    }
                }

                if let card = completion.cardAwarded {
                    HStack(spacing: 14) {
                        ConquestCardFace(
                            card: card,
                            territory: store.game?.territories.first { $0.id == card.territoryId }
                        )
                        .frame(width: 270, height: 112)

                        VStack(alignment: .leading, spacing: 8) {
                            Label("Added to your hand", systemImage: "rectangle.stack.fill")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(HealthRiskTheme.success)

                            Text("Collect three cards to trade for reinforcements.")
                                .font(.caption)
                                .foregroundStyle(HealthRiskTheme.muted)

                            Button("Continue") {
                                store.clearTurnCompletion()
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(HealthRiskTheme.accent)
                            .frame(maxWidth: .infinity)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else {
                    HStack(spacing: 16) {
                        Text("No conquest card was earned this turn.")
                            .font(.caption)
                            .foregroundStyle(HealthRiskTheme.muted)

                        Spacer()

                        Button("Continue") {
                            store.clearTurnCompletion()
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(HealthRiskTheme.accent)
                    }
                }
            }
            .padding(18)
            .frame(maxWidth: 620)
            .healthRiskSurface()
            .padding(24)
        }
        .transition(.opacity.combined(with: .scale(scale: 0.96)))
        .zIndex(10)
    }

    private func turnStat(_ label: String, value: Int) -> some View {
        VStack(spacing: 3) {
            Text("\(value)")
                .font(.title3.monospacedDigit().bold())
            Text(label)
                .font(.caption2)
                .foregroundStyle(HealthRiskTheme.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 9)
        .background(HealthRiskTheme.raisedPanel)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func gameCompletionOverlay(_ completion: GameCompletionPresentation) -> some View {
        ZStack {
            Color.black.opacity(0.72)
                .ignoresSafeArea()

            HStack(spacing: 22) {
                VStack(spacing: 12) {
                    Image(systemName: completion.didWin ? "trophy.fill" : "flag.checkered")
                        .font(.system(size: 48))
                        .foregroundStyle(completion.didWin ? Color.yellow : HealthRiskTheme.accent)
                    Text(completion.didWin ? "Victory" : "Campaign Complete")
                        .font(.largeTitle.bold())
                    Text("\(completion.winnerName) conquered the board.")
                        .font(.headline)
                        .foregroundStyle(HealthRiskTheme.muted)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)

                VStack(alignment: .leading, spacing: 10) {
                    Text("Final Standings")
                        .font(.headline)
                    ForEach(completion.standings) { standing in
                        HStack {
                            Image(systemName: standing.id == completion.winnerId ? "crown.fill" : "person.fill")
                                .foregroundStyle(standing.id == completion.winnerId ? Color.yellow : HealthRiskTheme.muted)
                            Text(standing.name)
                                .font(.subheadline.weight(.semibold))
                            Spacer()
                            Text("\(standing.territories) territories")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(HealthRiskTheme.muted)
                        }
                    }

                    HStack {
                        Button("View Final Board") {
                            hasDismissedGameResult = true
                        }
                        .buttonStyle(.bordered)

                        Button("Back to My Games") {
                            Task {
                                await onGameChanged()
                                dismiss()
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(HealthRiskTheme.accent)
                    }
                    .padding(.top, 4)
                }
                .frame(maxWidth: .infinity)
            }
            .padding(24)
            .frame(maxWidth: 720)
            .healthRiskSurface()
            .padding(24)
        }
        .transition(.opacity.combined(with: .scale(scale: 0.96)))
        .zIndex(11)
    }

    private func performReinforcement(territoryId: String) async {
        if await store.reinforce(territoryId: territoryId, count: troopCount) {
            resetSelection()
            await onGameChanged()
        } else {
            isShowingCommandPanel = true
            await invalidateIfUnauthorized()
        }
    }

    private func performCardTrade() async {
        if await store.tradeCards() {
            resetSelection()
            await onGameChanged()
        } else {
            isShowingCommandPanel = true
            await invalidateIfUnauthorized()
        }
    }

    private func performHealthLog(
        progress: GameplayExerciseProgress,
        units: Double
    ) async {
        if await store.logExercise(exerciseKey: progress.key, units: units) {
            resetSelection()
            await onGameChanged()
        } else {
            isShowingCommandPanel = true
            await invalidateIfUnauthorized()
        }
    }

    private func performSelectedAction() async {
        guard let selectedSourceId, let selectedTargetId, let game = store.game else { return }
        let succeeded: Bool
        switch actionMode {
        case .attack:
            let committedTroops = AttackRiskPolicy.committedTroops(
                sourceArmies: sourceTerritory(in: game)?.armies ?? troopCount + 1
            )
            succeeded = await store.attack(
                fromId: selectedSourceId,
                toId: selectedTargetId,
                committedTroops: committedTroops,
                stopLoss: AttackRiskPolicy.stopLoss(
                    committedTroops: committedTroops,
                    limitsLosses: limitsAttackLosses,
                    selectedLimit: stopLoss
                )
            )
        case .fortify:
            succeeded = await store.fortify(
                fromId: selectedSourceId,
                toId: selectedTargetId,
                count: troopCount
            )
        }

        if succeeded {
            resetSelection()
            await onGameChanged()
        } else {
            isShowingCommandPanel = true
            await invalidateIfUnauthorized()
        }
    }

    private func performEndTurn() async {
        if await store.endTurn() {
            resetSelection()
            await onGameChanged()
        } else {
            isShowingCommandPanel = true
            await invalidateIfUnauthorized()
        }
    }

    private func load() async {
        await store.load()
        resetSelection()
        if store.error?.isUnauthorized == true {
            await authenticationStore.invalidateSession()
        }
    }

    private func invalidateIfUnauthorized() async {
        if store.actionError?.isUnauthorized == true {
            await authenticationStore.invalidateSession()
        }
    }

    private func resetSelection() {
        inspectedTerritoryId = nil
        resetActionSelection()
        if let game = store.game, game.phase == .reinforce {
            troopCount = max(1, game.currentPlayerReinforcements)
        }
    }

    private func resetActionSelection() {
        selectedSourceId = nil
        selectedTargetId = nil
        troopCount = 1
        stopLoss = 1
        limitsAttackLosses = false
    }

    private var battleResultTitle: String {
        guard let result = store.lastAttackResult else { return "Battle Resolved" }
        return result.captured ? "Territory Captured" : "Attack Stopped"
    }

    private var parsedHealthUnits: Double? {
        let normalized = healthUnitsText
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: ",", with: ".")
        guard let value = Double(normalized), value.isFinite, value > 0 else { return nil }
        return value
    }

    private var exerciseLogMessage: String {
        guard let result = store.lastExerciseLog else { return "" }
        let goalName = store.game?.dashboard?.exercise?.progress
            .first { $0.key == result.exerciseKey }?.label ?? "Health progress"

        if result.deltaTroops > 0 {
            let troopLabel = result.deltaTroops == 1 ? "troop" : "troops"
            let capNote = result.totalCapApplied ? " Daily reward limits were applied." : ""
            return "\(goalName) was saved. +\(result.deltaTroops) reinforcement \(troopLabel) was banked; today’s health total is \(result.dayTotal).\(capNote)"
        }

        if result.totalCapApplied {
            return "\(goalName) was saved, but today’s reward limits prevented another troop from being added."
        }

        return "\(goalName) was saved. It did not add a whole troop yet, but fractional progress continues accumulating toward the next troop."
    }

    private func healthLoggingMessage(
        _ game: GameplayGame,
        dashboard: GameplayDashboard
    ) -> String {
        let bank = dashboard.availableReinforcements
            ?? game.players.first { $0.id == dashboard.playerId }?.pendingReinforcements
            ?? 0
        let destination: String
        switch game.healthLogging?.appliesTo {
        case .currentMove:
            destination = "Rewards are added to this move’s reinforcement bank."
        case .upcomingMove:
            destination = "Rewards are banked for your upcoming move."
        case .nextMove:
            destination = "Rewards are banked for your next move."
        case nil:
            destination = "Rewards are banked by the server for an eligible move."
        }
        return "\(destination) \(bank) currently available."
    }

    private func healthGoalProgressText(_ progress: GameplayExerciseProgress) -> String {
        if progress.trackingType == .checkbox {
            return progress.unitsLogged >= 1 ? "Completed today" : "Not completed today"
        }

        let logged = formattedNumber(progress.unitsLogged)
        guard let cap = progress.unitCap else {
            return "\(logged) \(pluralizedUnit(progress.unitLabel, count: progress.unitsLogged)) logged"
        }

        let counted = formattedNumber(progress.countedUnits)
        let capText = formattedNumber(cap)
        let unit = pluralizedUnit(progress.unitLabel, count: cap)
        if progress.unitsLogged > progress.countedUnits {
            return "\(counted)/\(capText) \(unit) counted · \(logged) logged"
        }
        return "\(counted)/\(capText) \(unit)"
    }

    private func healthConversionText(_ rule: HealthGoalRule) -> String {
        let rate = rule.troopsPerUnit
        let conversion: String
        if rate > 0, rate < 1 {
            let unitsPerTroop = 1 / rate
            conversion = "1 troop per \(formattedNumber(unitsPerTroop)) \(pluralizedUnit(rule.unitLabel, count: unitsPerTroop))"
        } else {
            conversion = "\(formattedNumber(rate)) \(rate == 1 ? "troop" : "troops") per \(rule.unitLabel)"
        }

        if let cap = rule.dailyUnitCap {
            return "\(conversion) · up to \(formattedNumber(cap)) \(pluralizedUnit(rule.unitLabel, count: cap)) per day"
        }
        return conversion
    }

    private func healthGoalSymbol(_ category: HealthCategory) -> String {
        switch category {
        case .movement: "figure.run"
        case .nutrition: "leaf.fill"
        case .recovery: "bed.double.fill"
        }
    }

    private func formattedNumber(_ value: Double) -> String {
        value.formatted(
            .number
                .precision(.fractionLength(0...2))
                .rounded(rule: .toNearestOrAwayFromZero)
        )
    }

    private func pluralizedUnit(_ unit: String, count: Double) -> String {
        guard count != 1, !unit.hasSuffix("s"), unit != "min" else { return unit }
        return "\(unit)s"
    }

    private var battleResultMessage: String {
        guard let result = store.lastAttackResult else { return "" }
        let exchangeLabel = result.rounds.count == 1 ? "exchange" : "exchanges"
        let lossSummary = "\(result.rounds.count) \(exchangeLabel). You lost \(result.totalAttackerLosses); the defender lost \(result.totalDefenderLosses)."

        if result.captured {
            return "\(pretty(result.toId)) is yours. \(lossSummary) \(result.survivingAttackers) surviving troops now hold it."
        }

        switch result.endReason {
        case .stopLoss:
            return "Your loss limit was reached. \(lossSummary) \(result.remainingDefenders) defenders remain."
        case .attackerMinimum:
            return "The attacking force could not continue. \(lossSummary) \(result.remainingDefenders) defenders remain."
        case .capture:
            return lossSummary
        }
    }

    private func turnMessage(_ game: GameplayGame, includesPhase: Bool = true) -> String {
        if game.status == .finished {
            let winner = game.players.first { $0.id == game.winnerId }?.name ?? "A player"
            return "\(winner) won the campaign"
        }
        if game.yourTurn {
            return includesPhase ? "Your turn · \(game.phase.rawValue.capitalized)" : "Your turn"
        }
        if let current = game.currentPlayer {
            return "Waiting for \(current.name)"
        }
        return "Waiting for the next daily session"
    }

    private func formattedDate(_ value: String?) -> String? {
        guard let value else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        guard let date else {
            return nil
        }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func pretty(_ id: String) -> String {
        id.split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}

private struct ConquestCardFace: View {
    let card: TerritoryCard
    let territory: GameplayTerritory?

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size

            ZStack {
                LinearGradient(
                    colors: [Color(red: 0.15, green: 0.21, blue: 0.29), HealthRiskTheme.background],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )

                RadialGradient(
                    colors: [continentColor.opacity(0.4), .clear],
                    center: .topTrailing,
                    startRadius: 2,
                    endRadius: size.width * 0.72
                )

                Image("WorldMap")
                    .resizable()
                    .interpolation(.high)
                    .frame(width: size.width, height: size.height)
                    .opacity(0.84)
                    .accessibilityHidden(true)

                if let point = TerritoryBoardView.webCoordinates[card.territoryId] {
                    let marker = CGPoint(
                        x: (point.x / TerritoryBoardView.mapSize.width) * size.width,
                        y: (point.y / TerritoryBoardView.mapSize.height) * size.height
                    )
                    Circle()
                        .fill(continentColor.opacity(0.3))
                        .frame(width: 24, height: 24)
                        .overlay {
                            Circle()
                                .stroke(.white.opacity(0.9), lineWidth: 1.5)
                        }
                        .position(marker)
                    Circle()
                        .fill(.white)
                        .frame(width: 8, height: 8)
                        .overlay {
                            Circle()
                                .stroke(continentColor, lineWidth: 2)
                        }
                        .position(marker)
                }

                LinearGradient(
                    colors: [.clear, Color.black.opacity(0.86)],
                    startPoint: .top,
                    endPoint: .bottom
                )

                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text("CONQUEST CARD")
                            .font(.system(size: 8, weight: .black, design: .rounded))
                            .tracking(1.2)
                            .foregroundStyle(continentColor)
                        Spacer()
                        Text("DAY \(card.earnedDay)")
                            .font(.system(size: 8, weight: .bold, design: .rounded))
                            .foregroundStyle(.white.opacity(0.72))
                    }

                    Spacer()

                    Text(pretty(card.territoryId))
                        .font(.headline.bold())
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Text(continentName)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(continentColor)
                }
                .padding(10)
            }
            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(continentColor.opacity(0.85), lineWidth: 1.2)
            }
            .shadow(color: continentColor.opacity(0.22), radius: 9, y: 4)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(pretty(card.territoryId)) conquest card, earned day \(card.earnedDay)")
    }

    private var continentName: String {
        pretty(territory?.continent ?? "territory")
    }

    private var continentColor: Color {
        switch territory?.continent {
        case "north_america": Color(red: 0.35, green: 0.61, blue: 0.84)
        case "south_america": Color(red: 0.33, green: 0.71, blue: 0.56)
        case "europe": Color(red: 0.60, green: 0.51, blue: 0.83)
        case "africa": Color(red: 0.83, green: 0.60, blue: 0.32)
        case "asia": Color(red: 0.82, green: 0.44, blue: 0.51)
        case "australia": Color(red: 0.33, green: 0.67, blue: 0.66)
        default: HealthRiskTheme.accent
        }
    }

    private func pretty(_ id: String) -> String {
        id.split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}

private struct TerritoryBoardView: View {
    let territories: [GameplayTerritory]
    let guide: GameplaySelectionGuide
    let selectedSourceId: String?
    let selectedTargetId: String?
    let inspectedTerritoryId: String?
    let showsActionGuidance: Bool
    let onSelect: (String) -> Void
    @State private var zoomScale: CGFloat = 1
    @State private var panOffset: CGSize = .zero
    @State private var hasInteractedWithMap = false
    @GestureState private var gestureZoomScale: CGFloat = 1
    @GestureState private var gesturePanOffset: CGSize = .zero

    var body: some View {
        GeometryReader { proxy in
            let mapRect = mapRect(in: proxy.size)
            let scale = mapScale(in: mapRect)
            let nodeDiameter = min(34, max(24, 34 * scale))
            let displayedZoomScale = clampedZoom(zoomScale * gestureZoomScale)
            let displayedPanOffset = constrainedOffset(
                CGSize(
                    width: panOffset.width + gesturePanOffset.width,
                    height: panOffset.height + gesturePanOffset.height
                ),
                zoomScale: displayedZoomScale,
                viewportSize: mapRect.size
            )
            let mapAnchor = UnitPoint(
                x: mapRect.midX / max(1, proxy.size.width),
                y: mapRect.midY / max(1, proxy.size.height)
            )
            let mapControlY = mapRect.maxY - 28
            ZStack {
                ZStack {
                    Image("WorldMap")
                        .resizable()
                        .interpolation(.high)
                        .frame(width: mapRect.width, height: mapRect.height)
                        .position(x: mapRect.midX, y: mapRect.midY)
                        .accessibilityHidden(true)

                    Canvas { context, size in
                        drawEdges(context: &context, mapRect: mapRect, scale: scale)
                        drawContinentLabels(context: &context, mapRect: mapRect, scale: scale)
                        drawTerritoryLabels(context: &context, mapRect: mapRect, scale: scale)
                    }
                    .allowsHitTesting(false)

                    ForEach(territories) { territory in
                        let isSource = selectedSourceId == territory.id
                        let isTarget = selectedTargetId == territory.id
                        let isInspected = inspectedTerritoryId == territory.id
                        let isActionable = guide.actionableIds.contains(territory.id)
                        let isDimmed = showsActionGuidance && !isActionable && !isInspected
                        Button {
                            hasInteractedWithMap = true
                            onSelect(territory.id)
                        } label: {
                            ZStack {
                                Circle()
                                    .fill(Color(hex: territory.color) ?? HealthRiskTheme.muted)
                                    .frame(width: nodeDiameter, height: nodeDiameter)
                                Text("\(territory.armies)")
                                    .font(.system(size: max(8, nodeDiameter * 0.37), weight: .bold, design: .rounded))
                                    .foregroundStyle(Color(red: 0.05, green: 0.06, blue: 0.08))
                            }
                            .frame(width: 44, height: 44)
                            .overlay {
                                Circle()
                                    .stroke(
                                        nodeStrokeColor(
                                            isSource: isSource,
                                            isTarget: isTarget,
                                            isInspected: isInspected,
                                            isActionable: isActionable
                                        ),
                                        lineWidth: nodeStrokeWidth(
                                            isSource: isSource,
                                            isTarget: isTarget,
                                            isInspected: isInspected,
                                            isActionable: isActionable
                                        )
                                    )
                                    .frame(width: nodeDiameter + (isActionable ? 5 : 0), height: nodeDiameter + (isActionable ? 5 : 0))
                            }
                            .shadow(
                                color: nodeShadowColor(
                                    isSource: isSource,
                                    isTarget: isTarget,
                                    isActionable: isActionable
                                ),
                                radius: (isSource || isTarget || isActionable) ? 6 : 3
                            )
                            .opacity(isDimmed ? 0.42 : 1)
                        }
                        .buttonStyle(.plain)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                        .position(point(for: territory.id, in: mapRect))
                        .accessibilityLabel(accessibilityLabel(territory))
                        .accessibilityHint(accessibilityHint(isActionable: isActionable))
                        .zIndex((isSource || isTarget) ? 3 : (isActionable ? 2 : 1))
                    }
                }
                .scaleEffect(displayedZoomScale, anchor: mapAnchor)
                .offset(displayedPanOffset)

                if !hasInteractedWithMap {
                    Label(
                        showsActionGuidance
                            ? "Drag to move · pinch to zoom"
                            : "Tap territory to inspect · drag or pinch to explore",
                        systemImage: "hand.draw.fill"
                    )
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(HealthRiskTheme.muted)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 7)
                        .background(.ultraThinMaterial)
                        .clipShape(Capsule())
                        .position(x: mapRect.midX, y: mapControlY)
                        .allowsHitTesting(false)
                }

                if isMapTransformed {
                    Button {
                        resetMap()
                    } label: {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.subheadline.weight(.bold))
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .background(.ultraThinMaterial)
                    .clipShape(Circle())
                    .position(x: 34, y: mapControlY)
                    .accessibilityLabel("Reset map position and zoom")
                }
            }
            .contentShape(Rectangle())
            .clipped()
            .simultaneousGesture(panGesture(viewportSize: mapRect.size))
            .simultaneousGesture(zoomGesture(viewportSize: mapRect.size))
        }
    }

    private var isMapTransformed: Bool {
        zoomScale > 1.001 || abs(panOffset.width) > 1 || abs(panOffset.height) > 1
    }

    private func panGesture(viewportSize: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .updating($gesturePanOffset) { value, state, _ in
                state = value.translation
            }
            .onChanged { _ in
                hasInteractedWithMap = true
            }
            .onEnded { value in
                let proposed = CGSize(
                    width: panOffset.width + value.translation.width,
                    height: panOffset.height + value.translation.height
                )
                panOffset = constrainedOffset(
                    proposed,
                    zoomScale: zoomScale,
                    viewportSize: viewportSize
                )
            }
    }

    private func zoomGesture(viewportSize: CGSize) -> some Gesture {
        MagnifyGesture()
            .updating($gestureZoomScale) { value, state, _ in
                state = value.magnification
            }
            .onChanged { _ in
                hasInteractedWithMap = true
            }
            .onEnded { value in
                let nextZoomScale = clampedZoom(zoomScale * value.magnification)
                zoomScale = nextZoomScale
                panOffset = constrainedOffset(
                    panOffset,
                    zoomScale: nextZoomScale,
                    viewportSize: viewportSize
                )
            }
    }

    private func clampedZoom(_ proposed: CGFloat) -> CGFloat {
        min(3.5, max(1, proposed))
    }

    private func constrainedOffset(
        _ proposed: CGSize,
        zoomScale: CGFloat,
        viewportSize: CGSize
    ) -> CGSize {
        let horizontalLimit = max(24, viewportSize.width * (zoomScale - 1) / 2 + 24)
        let verticalLimit = max(72, viewportSize.height * (zoomScale - 1) / 2 + 72)
        return CGSize(
            width: min(horizontalLimit, max(-horizontalLimit, proposed.width)),
            height: min(verticalLimit, max(-verticalLimit, proposed.height))
        )
    }

    private func resetMap() {
        withAnimation(.easeInOut(duration: 0.2)) {
            zoomScale = 1
            panOffset = .zero
        }
    }

    private func nodeStrokeColor(
        isSource: Bool,
        isTarget: Bool,
        isInspected: Bool,
        isActionable: Bool
    ) -> Color {
        if isSource { return Color.yellow }
        if isTarget { return Color.white }
        if isActionable { return HealthRiskTheme.accent }
        if isInspected { return Color.white.opacity(0.9) }
        return Color.white.opacity(0.65)
    }

    private func nodeStrokeWidth(
        isSource: Bool,
        isTarget: Bool,
        isInspected: Bool,
        isActionable: Bool
    ) -> CGFloat {
        if isSource || isTarget { return 3 }
        if isActionable || isInspected { return 2 }
        return 1
    }

    private func nodeShadowColor(isSource: Bool, isTarget: Bool, isActionable: Bool) -> Color {
        if isSource { return Color.yellow.opacity(0.65) }
        if isTarget { return Color.white.opacity(0.65) }
        if isActionable { return HealthRiskTheme.accent.opacity(0.55) }
        return Color.black.opacity(0.35)
    }

    private func drawEdges(context: inout GraphicsContext, mapRect: CGRect, scale: CGFloat) {
        var seen: Set<String> = []
        let ids = Set(territories.map(\.id))
        for territory in territories {
            for neighbor in territory.neighbors where ids.contains(neighbor) {
                let key = [territory.id, neighbor].sorted().joined(separator: "|")
                guard seen.insert(key).inserted else { continue }

                guard
                    let from = Self.webCoordinates[territory.id],
                    let to = Self.webCoordinates[neighbor]
                else { continue }

                let isOcean = Self.oceanEdges.contains(key)
                let stroke = Color(red: 0.41, green: 0.48, blue: 0.56)
                    .opacity(isOcean ? 0.72 : 0.68)
                let style = StrokeStyle(
                    lineWidth: max(0.8, 1.25 * scale),
                    lineCap: .round,
                    lineJoin: .round,
                    dash: isOcean ? [max(2.5, 4 * scale), max(2.5, 4 * scale)] : []
                )

                if key == "alaska|kamchatka" {
                    drawWrappedAlaskaEdge(
                        context: &context,
                        fromId: territory.id,
                        from: from,
                        to: to,
                        mapRect: mapRect,
                        stroke: stroke,
                        style: style
                    )
                    continue
                }

                var path = Path()
                path.move(to: scaled(from, in: mapRect))
                if isOcean {
                    path.addQuadCurve(
                        to: scaled(to, in: mapRect),
                        control: scaled(oceanControlPoint(from: from, to: to, key: key), in: mapRect)
                    )
                } else {
                    path.addLine(to: scaled(to, in: mapRect))
                }
                context.stroke(path, with: .color(stroke), style: style)
            }
        }
    }

    private func drawWrappedAlaskaEdge(
        context: inout GraphicsContext,
        fromId: String,
        from: CGPoint,
        to: CGPoint,
        mapRect: CGRect,
        stroke: Color,
        style: StrokeStyle
    ) {
        let alaska = fromId == "alaska" ? from : to
        let kamchatka = fromId == "kamchatka" ? from : to
        let top = min(alaska.y, kamchatka.y)

        var left = Path()
        left.move(to: scaled(alaska, in: mapRect))
        left.addQuadCurve(
            to: scaled(CGPoint(x: 18, y: top - 8), in: mapRect),
            control: scaled(CGPoint(x: 45, y: top - 18), in: mapRect)
        )
        context.stroke(left, with: .color(stroke), style: style)

        var right = Path()
        right.move(to: scaled(CGPoint(x: 962, y: top - 8), in: mapRect))
        right.addQuadCurve(
            to: scaled(kamchatka, in: mapRect),
            control: scaled(CGPoint(x: 935, y: top - 18), in: mapRect)
        )
        context.stroke(right, with: .color(stroke), style: style)
    }

    private func oceanControlPoint(from: CGPoint, to: CGPoint, key: String) -> CGPoint {
        let dx = to.x - from.x
        let dy = to.y - from.y
        let length = max(1, hypot(dx, dy))
        let bend = min(38, length * 0.18)
        let direction: CGFloat = Self.negativeOceanCurves.contains(key) ? -1 : 1
        return CGPoint(
            x: (from.x + to.x) / 2 + (-dy / length) * bend * direction,
            y: (from.y + to.y) / 2 + (dx / length) * bend * direction
        )
    }

    private func drawContinentLabels(
        context: inout GraphicsContext,
        mapRect: CGRect,
        scale: CGFloat
    ) {
        for continent in Self.continentLabels {
            let text = Text(continent.label)
                .font(.system(size: max(7, 12 * scale), weight: .bold, design: .rounded))
                .tracking(max(0.8, 1.7 * scale))
                .foregroundStyle(continent.color)
            context.draw(
                text,
                at: scaled(continent.point, in: mapRect),
                anchor: .center
            )
        }
    }

    private func drawTerritoryLabels(
        context: inout GraphicsContext,
        mapRect: CGRect,
        scale: CGFloat
    ) {
        let fontSize = max(7, min(10, 10 * scale))
        for territory in territories {
            guard let point = Self.webCoordinates[territory.id] else { continue }
            let labelPoint = CGPoint(x: point.x, y: point.y - 18)
            let label = Text(pretty(territory.id))
                .font(.system(size: fontSize, weight: .semibold, design: .rounded))
                .foregroundStyle(Color(red: 0.82, green: 0.85, blue: 0.89))
            var labelContext = context
            labelContext.addFilter(.shadow(color: HealthRiskTheme.background, radius: 2))
            labelContext.draw(label, at: scaled(labelPoint, in: mapRect), anchor: .center)
        }
    }

    private func mapRect(in size: CGSize) -> CGRect {
        let topInset = max(44, min(54, size.height * 0.13))
        let bottomInset = max(4, min(10, size.height * 0.02))
        return CGRect(
            x: 0,
            y: topInset,
            width: size.width,
            height: max(1, size.height - topInset - bottomInset)
        )
    }

    private func mapScale(in mapRect: CGRect) -> CGFloat {
        min(mapRect.width / Self.mapSize.width, mapRect.height / Self.mapSize.height)
    }

    private func point(for id: String, in mapRect: CGRect) -> CGPoint {
        scaled(Self.webCoordinates[id] ?? .zero, in: mapRect)
    }

    private func scaled(_ point: CGPoint, in mapRect: CGRect) -> CGPoint {
        CGPoint(
            x: mapRect.minX + (point.x / Self.mapSize.width) * mapRect.width,
            y: mapRect.minY + (point.y / Self.mapSize.height) * mapRect.height
        )
    }

    private func pretty(_ id: String) -> String {
        id.split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    private func accessibilityLabel(_ territory: GameplayTerritory) -> String {
        "\(pretty(territory.id)), \(territory.armies) armies"
    }

    private func accessibilityHint(isActionable: Bool) -> String {
        if isActionable {
            return "Double tap to select for your current move"
        }
        return "Double tap to inspect this territory"
    }

    fileprivate static let mapSize = CGSize(width: 980, height: 545)

    private static let continentLabels: [(label: String, color: Color, point: CGPoint)] = [
        ("NORTH AMERICA", Color(red: 0.35, green: 0.61, blue: 0.84), CGPoint(x: 105, y: 50)),
        ("SOUTH AMERICA", Color(red: 0.33, green: 0.71, blue: 0.56), CGPoint(x: 218, y: 493)),
        ("EUROPE", Color(red: 0.60, green: 0.51, blue: 0.83), CGPoint(x: 470, y: 48)),
        ("AFRICA", Color(red: 0.83, green: 0.60, blue: 0.32), CGPoint(x: 466, y: 474)),
        ("ASIA", Color(red: 0.82, green: 0.44, blue: 0.51), CGPoint(x: 740, y: 52)),
        ("AUSTRALIA", Color(red: 0.33, green: 0.67, blue: 0.66), CGPoint(x: 818, y: 466)),
    ]

    private static let oceanEdges: Set<String> = [
        "alaska|kamchatka", "greenland|iceland", "brazil|north_africa",
        "east_africa|madagascar", "madagascar|south_africa", "japan|kamchatka",
        "japan|mongolia", "indonesia|siam", "indonesia|new_guinea",
        "indonesia|western_australia", "eastern_australia|new_guinea",
    ]

    private static let negativeOceanCurves: Set<String> = [
        "greenland|iceland", "brazil|north_africa", "indonesia|siam",
    ]

    fileprivate static let webCoordinates: [String: CGPoint] = [
        "alaska": CGPoint(x: 97, y: 80),
        "northwest_territory": CGPoint(x: 183, y: 80),
        "greenland": CGPoint(x: 378, y: 55),
        "alberta": CGPoint(x: 188, y: 121),
        "ontario": CGPoint(x: 267, y: 132),
        "quebec": CGPoint(x: 312, y: 125),
        "western_us": CGPoint(x: 194, y: 173),
        "eastern_us": CGPoint(x: 275, y: 176),
        "central_america": CGPoint(x: 238, y: 250),
        "venezuela": CGPoint(x: 317, y: 291),
        "peru": CGPoint(x: 293, y: 354),
        "brazil": CGPoint(x: 354, y: 365),
        "argentina": CGPoint(x: 320, y: 457),
        "iceland": CGPoint(x: 440, y: 77),
        "great_britain": CGPoint(x: 475, y: 117),
        "scandinavia": CGPoint(x: 537, y: 88),
        "northern_europe": CGPoint(x: 530, y: 123),
        "western_europe": CGPoint(x: 473, y: 152),
        "southern_europe": CGPoint(x: 540, y: 166),
        "ukraine": CGPoint(x: 579, y: 136),
        "north_africa": CGPoint(x: 477, y: 213),
        "egypt": CGPoint(x: 566, y: 214),
        "east_africa": CGPoint(x: 590, y: 302),
        "congo": CGPoint(x: 550, y: 332),
        "south_africa": CGPoint(x: 553, y: 424),
        "madagascar": CGPoint(x: 613, y: 387),
        "ural": CGPoint(x: 647, y: 95),
        "siberia": CGPoint(x: 739, y: 77),
        "yakutsk": CGPoint(x: 818, y: 73),
        "kamchatka": CGPoint(x: 910, y: 103),
        "irkutsk": CGPoint(x: 765, y: 117),
        "mongolia": CGPoint(x: 768, y: 147),
        "japan": CGPoint(x: 857, y: 181),
        "afghanistan": CGPoint(x: 666, y: 191),
        "china": CGPoint(x: 763, y: 191),
        "middle_east": CGPoint(x: 606, y: 215),
        "india": CGPoint(x: 695, y: 239),
        "siam": CGPoint(x: 755, y: 265),
        "indonesia": CGPoint(x: 792, y: 328),
        "new_guinea": CGPoint(x: 870, y: 339),
        "western_australia": CGPoint(x: 799, y: 413),
        "eastern_australia": CGPoint(x: 875, y: 413),
    ]
}

private extension Color {
    init?(hex: String?) {
        guard let hex else { return nil }
        let value = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        guard value.count == 6, let integer = UInt64(value, radix: 16) else { return nil }
        self.init(
            red: Double((integer >> 16) & 0xFF) / 255,
            green: Double((integer >> 8) & 0xFF) / 255,
            blue: Double(integer & 0xFF) / 255
        )
    }
}
