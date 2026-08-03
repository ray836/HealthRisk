import SwiftUI

struct HealthRulesEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: WaitingRoomStore
    let game: LobbyGameView
    let onUnauthorized: @MainActor () async -> Void

    @State private var goals: [HealthGoalDraft]
    @State private var movementCap: String
    @State private var nutritionCap: String
    @State private var recoveryCap: String
    @State private var dailyTotalCap: String
    @State private var validationMessage: String?

    init(
        store: WaitingRoomStore,
        game: LobbyGameView,
        onUnauthorized: @escaping @MainActor () async -> Void
    ) {
        self.store = store
        self.game = game
        self.onUnauthorized = onUnauthorized
        _goals = State(initialValue: game.exercises.map(HealthGoalDraft.init))
        _movementCap = State(initialValue: Self.text(game.categoryTroopCaps[HealthCategory.movement.rawValue]))
        _nutritionCap = State(initialValue: Self.text(game.categoryTroopCaps[HealthCategory.nutrition.rawValue]))
        _recoveryCap = State(initialValue: Self.text(game.categoryTroopCaps[HealthCategory.recovery.rawValue]))
        _dailyTotalCap = State(initialValue: Self.text(game.dailyTotalTroopCap))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                HealthRiskTheme.appBackground

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        introduction

                        ForEach($goals) { $goal in
                            HealthGoalEditorCard(
                                goal: $goal,
                                canDelete: goals.count > 1,
                                onDelete: { goals.removeAll { $0.id == goal.id } }
                            )
                        }

                        Button {
                            guard goals.count < 12 else { return }
                            goals.append(.newGoal())
                        } label: {
                            Label("Add Health Goal", systemImage: "plus")
                                .fontWeight(.semibold)
                                .frame(maxWidth: .infinity)
                                .frame(height: 42)
                        }
                        .buttonStyle(.bordered)
                        .tint(HealthRiskTheme.accent)
                        .disabled(goals.count >= 12 || store.isUpdatingRules)

                        limitsEditor

                        if let validationMessage {
                            Label(validationMessage, systemImage: "exclamationmark.triangle.fill")
                                .font(.caption)
                                .foregroundStyle(HealthRiskTheme.danger)
                                .padding(14)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(HealthRiskTheme.danger.opacity(0.09))
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }

                        if let error = store.rulesError {
                            ServerErrorView(error: error)
                        }

                        saveButton
                    }
                    .padding(18)
                }
            }
            .navigationTitle("Edit Health Goals")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(store.isUpdatingRules)
                }
            }
        }
        .foregroundStyle(HealthRiskTheme.text)
        .interactiveDismissDisabled(store.isUpdatingRules)
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Lobby health rules")
                .font(.title2.bold())
            Text("Changes are saved on the server and immediately shown to everyone. All players must review their choices again before the game starts.")
                .font(.subheadline)
                .foregroundStyle(HealthRiskTheme.muted)
        }
    }

    private var limitsEditor: some View {
        VStack(alignment: .leading, spacing: 15) {
            Text("Daily troop limits")
                .font(.headline)
            Text("Category limits are optional. The overall limit applies across every health goal.")
                .font(.caption)
                .foregroundStyle(HealthRiskTheme.muted)

            capField("Movement", text: $movementCap)
            capField("Nutrition", text: $nutritionCap)
            capField("Recovery", text: $recoveryCap)

            Divider().overlay(HealthRiskTheme.line)

            VStack(alignment: .leading, spacing: 6) {
                Text("Overall troops per day")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HealthRiskTheme.muted)
                TextField("1–50", text: $dailyTotalCap)
                    .keyboardType(.decimalPad)
                    .healthRuleField()
            }
        }
        .padding(18)
        .healthRiskSurface()
    }

    private func capField(_ label: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(label) cap")
                .font(.caption.weight(.semibold))
                .foregroundStyle(HealthRiskTheme.muted)
            TextField("No category cap", text: text)
                .keyboardType(.decimalPad)
                .healthRuleField()
        }
    }

    private var saveButton: some View {
        Button {
            Task { await save() }
        } label: {
            HStack(spacing: 9) {
                if store.isUpdatingRules {
                    ProgressView().tint(.white)
                }
                Text(store.isUpdatingRules ? "Saving…" : "Save Health Goals")
                    .fontWeight(.bold)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 50)
        }
        .buttonStyle(.borderedProminent)
        .tint(HealthRiskTheme.accent)
        .disabled(store.isUpdatingRules)
    }

    private func save() async {
        validationMessage = nil
        store.clearRulesError()
        guard let request = makeRequest() else {
            validationMessage = "Enter valid numbers for troop rewards and limits. Leave a per-goal or category limit blank only when it should be unlimited."
            return
        }

        if await store.updateRules(request) {
            dismiss()
        } else {
            await onUnauthorized()
        }
    }

    private func makeRequest() -> HealthRulesUpdateRequest? {
        guard !goals.isEmpty,
              let totalCap = Double(dailyTotalCap) else {
            return nil
        }

        var rules: [HealthGoalRule] = []
        for goal in goals {
            guard let troopValue = Double(goal.troopsPerUnit) else { return nil }
            let unitCap: Double?
            if goal.trackingType == .checkbox {
                unitCap = 1
            } else if goal.dailyUnitCap.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                unitCap = nil
            } else if let parsed = Double(goal.dailyUnitCap) {
                unitCap = parsed
            } else {
                return nil
            }

            rules.append(
                HealthGoalRule(
                    key: goal.label,
                    label: goal.label,
                    unitLabel: goal.trackingType == .checkbox ? "completion" : goal.unitLabel,
                    category: goal.category,
                    trackingType: goal.trackingType,
                    troopsPerUnit: troopValue,
                    dailyUnitCap: unitCap
                )
            )
        }

        var categoryCaps: [String: Double] = [:]
        for (category, value) in [
            (HealthCategory.movement, movementCap),
            (.nutrition, nutritionCap),
            (.recovery, recoveryCap),
        ] {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            guard let parsed = Double(trimmed) else { return nil }
            categoryCaps[category.rawValue] = parsed
        }

        return HealthRulesUpdateRequest(
            revision: game.revision,
            exercises: rules,
            categoryTroopCaps: categoryCaps,
            dailyTotalTroopCap: totalCap
        )
    }

    private static func text(_ value: Double?) -> String {
        guard let value else { return "" }
        return value.formatted(.number.precision(.fractionLength(0...3)))
    }
}

private struct HealthGoalDraft: Identifiable, Equatable {
    let id: UUID
    var label: String
    var unitLabel: String
    var category: HealthCategory
    var trackingType: HealthTrackingType
    var troopsPerUnit: String
    var dailyUnitCap: String

    init(rule: HealthGoalRule) {
        id = UUID()
        label = rule.label
        unitLabel = rule.unitLabel
        category = rule.category
        trackingType = rule.trackingType
        troopsPerUnit = rule.troopsPerUnit.formatted(.number.precision(.fractionLength(0...3)))
        dailyUnitCap = rule.dailyUnitCap?.formatted(.number.precision(.fractionLength(0...3))) ?? ""
    }

    static func newGoal() -> HealthGoalDraft {
        HealthGoalDraft(
            id: UUID(),
            label: "New health goal",
            unitLabel: "unit",
            category: .movement,
            trackingType: .quantity,
            troopsPerUnit: "1",
            dailyUnitCap: "1"
        )
    }

    private init(
        id: UUID,
        label: String,
        unitLabel: String,
        category: HealthCategory,
        trackingType: HealthTrackingType,
        troopsPerUnit: String,
        dailyUnitCap: String
    ) {
        self.id = id
        self.label = label
        self.unitLabel = unitLabel
        self.category = category
        self.trackingType = trackingType
        self.troopsPerUnit = troopsPerUnit
        self.dailyUnitCap = dailyUnitCap
    }
}

private struct HealthGoalEditorCard: View {
    @Binding var goal: HealthGoalDraft
    let canDelete: Bool
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                TextField("Health goal", text: $goal.label)
                    .font(.headline)
                    .healthRuleField()
                Button(role: .destructive, action: onDelete) {
                    Image(systemName: "trash")
                }
                .disabled(!canDelete)
                .accessibilityLabel("Remove \(goal.label)")
            }

            HStack(spacing: 10) {
                menuPicker("Category", selection: $goal.category) {
                    ForEach(HealthCategory.allCases) { category in
                        Text(category.rawValue.capitalized).tag(category)
                    }
                }
                menuPicker("Track as", selection: $goal.trackingType) {
                    ForEach(HealthTrackingType.allCases) { trackingType in
                        Text(trackingLabel(trackingType)).tag(trackingType)
                    }
                }
            }

            if goal.trackingType != .checkbox {
                editorField("Unit", placeholder: "mile, minute, serving", text: $goal.unitLabel)
            }
            editorField("Troops per unit", placeholder: "0.01–20", text: $goal.troopsPerUnit, numeric: true)
            if goal.trackingType != .checkbox {
                editorField("Daily unit limit", placeholder: "Blank for unlimited", text: $goal.dailyUnitCap, numeric: true)
            }
        }
        .padding(16)
        .healthRiskSurface()
    }

    private func editorField(
        _ label: String,
        placeholder: String,
        text: Binding<String>,
        numeric: Bool = false
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HealthRiskTheme.muted)
            TextField(placeholder, text: text)
                .keyboardType(numeric ? .decimalPad : .default)
                .healthRuleField()
        }
    }

    private func menuPicker<Selection: Hashable, Content: View>(
        _ label: String,
        selection: Binding<Selection>,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HealthRiskTheme.muted)
            Picker(label, selection: selection, content: content)
                .pickerStyle(.menu)
                .tint(HealthRiskTheme.accent)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .frame(height: 44)
                .background(HealthRiskTheme.background.opacity(0.72))
                .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        }
        .frame(maxWidth: .infinity)
    }

    private func trackingLabel(_ type: HealthTrackingType) -> String {
        switch type {
        case .quantity: "Quantity"
        case .duration: "Duration"
        case .checkbox: "Done / not done"
        }
    }
}

private extension View {
    func healthRuleField() -> some View {
        padding(.horizontal, 12)
            .frame(height: 44)
            .background(HealthRiskTheme.background.opacity(0.72))
            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .stroke(HealthRiskTheme.line, lineWidth: 1)
            }
    }
}
