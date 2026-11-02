import SwiftUI
import UIKit

/// The few native colors the shell draws itself (lock, pairing, cover). Values
/// follow the core-ui tokens used on the approved phone boards; everything
/// else is drawn by core-ui inside the web host.
enum Theme {
    static let accent = dynamic(light: 0x0053FD, dark: 0x4D8BFF)
    static let text = dynamic(light: 0x252528, dark: 0xF2F3F7)
    static let secondaryText = dynamic(light: 0x6B6E76, dark: 0xA3A7B0)
    static let background = dynamic(light: 0xF8F9FE, dark: 0x1B1F27)
    static let surface = dynamic(light: 0xFFFFFF, dark: 0x252A34)

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { traits in
            uiColor(traits.userInterfaceStyle == .dark ? dark : light)
        })
    }

    private static func uiColor(_ hex: UInt32) -> UIColor {
        UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Theme.accent.opacity(configuration.isPressed ? 0.8 : 1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
