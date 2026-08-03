import SwiftUI

struct ServerErrorView: View {
    let error: APIError

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(error.message, systemImage: "exclamationmark.triangle.fill")
                .font(.callout.weight(.semibold))
                .foregroundStyle(HealthRiskTheme.danger)

            if error.retryable {
                Text("This request is safe to retry.")
                    .font(.caption)
                    .foregroundStyle(HealthRiskTheme.muted)
            }

            if let requestId = error.requestId {
                Text("Request ID: \(requestId)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(HealthRiskTheme.muted)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(HealthRiskTheme.danger.opacity(0.09))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(HealthRiskTheme.danger.opacity(0.35), lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }
}
