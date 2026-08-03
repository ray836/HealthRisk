import SwiftUI

struct AuthenticationView: View {
    enum Mode: String, CaseIterable, Identifiable {
        case login = "Log In"
        case signup = "Create Account"

        var id: String { rawValue }
    }

    @ObservedObject var store: AuthenticationStore
    @State private var mode: Mode = .login
    @State private var username = ""
    @State private var password = ""

    private var canSubmit: Bool {
        !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !password.isEmpty
            && !store.isSubmitting
    }

    var body: some View {
        ZStack {
            HealthRiskTheme.appBackground

            ScrollView {
                VStack(spacing: 26) {
                    brand
                    form
                }
                .frame(maxWidth: 520)
                .padding(.horizontal, 22)
                .padding(.vertical, 42)
                .frame(maxWidth: .infinity)
            }
        }
        .foregroundStyle(HealthRiskTheme.text)
    }

    private var brand: some View {
        VStack(spacing: 13) {
            ZStack {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(HealthRiskTheme.accent.opacity(0.16))
                    .frame(width: 72, height: 72)
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(HealthRiskTheme.accent.opacity(0.62), lineWidth: 1)
                    .frame(width: 72, height: 72)
                Image(systemName: "figure.run.circle.fill")
                    .font(.system(size: 36, weight: .semibold))
                    .foregroundStyle(HealthRiskTheme.accent)
            }

            VStack(spacing: 5) {
                Text("HEALTHRISK")
                    .font(.title.bold())
                    .tracking(2.2)
                Text("Health goals become reinforcements.")
                    .font(.subheadline)
                    .foregroundStyle(HealthRiskTheme.muted)
            }
        }
        .multilineTextAlignment(.center)
    }

    private var form: some View {
        VStack(spacing: 18) {
            Picker("Account action", selection: $mode) {
                ForEach(Mode.allCases) { mode in
                    Text(mode.rawValue).tag(mode)
                }
            }
            .pickerStyle(.segmented)

            VStack(spacing: 13) {
                TextField("Username", text: $username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textContentType(.username)
                    .submitLabel(.next)
                    .healthRiskField()

                SecureField("Password", text: $password)
                    .textContentType(mode == .signup ? .newPassword : .password)
                    .submitLabel(.go)
                    .onSubmit(submit)
                    .healthRiskField()
            }

            if mode == .signup {
                Text("Usernames use 3–24 letters, digits, underscores, or hyphens. Passwords use 8–128 characters.")
                    .font(.caption)
                    .foregroundStyle(HealthRiskTheme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let error = store.error {
                ServerErrorView(error: error)
            }

            Button(action: submit) {
                HStack(spacing: 9) {
                    if store.isSubmitting {
                        ProgressView().tint(.white)
                    }
                    Text(mode.rawValue)
                        .fontWeight(.bold)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 50)
            }
            .buttonStyle(.borderedProminent)
            .tint(HealthRiskTheme.accent)
            .disabled(!canSubmit)
        }
        .padding(22)
        .healthRiskSurface()
    }

    private func submit() {
        guard canSubmit else { return }
        Task {
            switch mode {
            case .login:
                await store.login(username: username, password: password)
            case .signup:
                await store.signup(username: username, password: password)
            }
        }
    }
}

private extension View {
    func healthRiskField() -> some View {
        padding(.horizontal, 14)
            .frame(height: 50)
            .background(HealthRiskTheme.background.opacity(0.72))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(HealthRiskTheme.line, lineWidth: 1)
            }
    }
}
