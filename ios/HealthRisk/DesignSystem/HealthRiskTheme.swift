import SwiftUI

enum HealthRiskTheme {
    static let background = Color(red: 15 / 255, green: 19 / 255, blue: 25 / 255)
    static let panel = Color(red: 26 / 255, green: 32 / 255, blue: 41 / 255)
    static let raisedPanel = Color(red: 34 / 255, green: 43 / 255, blue: 55 / 255)
    static let line = Color(red: 52 / 255, green: 65 / 255, blue: 82 / 255)
    static let text = Color(red: 238 / 255, green: 242 / 255, blue: 248 / 255)
    static let muted = Color(red: 156 / 255, green: 167 / 255, blue: 181 / 255)
    static let accent = Color(red: 110 / 255, green: 168 / 255, blue: 254 / 255)
    static let success = Color(red: 105 / 255, green: 211 / 255, blue: 155 / 255)
    static let danger = Color(red: 255 / 255, green: 140 / 255, blue: 130 / 255)

    static var appBackground: some View {
        ZStack {
            background
            RadialGradient(
                colors: [accent.opacity(0.13), .clear],
                center: .topTrailing,
                startRadius: 10,
                endRadius: 520
            )
        }
        .ignoresSafeArea()
    }
}

struct HealthRiskSurface: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(HealthRiskTheme.panel)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(HealthRiskTheme.line, lineWidth: 1)
            }
            .shadow(color: .black.opacity(0.22), radius: 20, y: 10)
    }
}

extension View {
    func healthRiskSurface() -> some View {
        modifier(HealthRiskSurface())
    }
}
