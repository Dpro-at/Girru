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
    // Phone boards Tasks, Approvals, Team (light) and ApprovalsDark.
    static let card = dynamic(light: 0xFDFDFD, dark: 0x0E0F12)
    static let border = dynamic(light: 0xD5DFF4, dark: 0x1D2636)
    static let divider = dynamic(light: 0xE8EDF8, dark: 0x1D2636)
    static let quote = dynamic(light: 0xF3F7FF, dark: 0x141A24)
    static let segment = dynamic(light: 0xE1E7F7, dark: 0x141A24)
    static let waiting = dynamic(light: 0xA15C00, dark: 0xE0A040)
    static let waitingCard = dynamic(light: 0xFFFAF3, dark: 0x1E1709)
    static let waitingBorder = dynamic(light: 0xE8C9A0, dark: 0x5A4214)
    static let done = dynamic(light: 0x0E7A43, dark: 0x4CC38A)
    static let doneSoft = dynamic(light: 0xE7F0E9, dark: 0x12271B)
    /// Agent avatar colours, picked by the agent id so one agent keeps its colour.
    static let avatars: [Color] = [0x0053FD, 0xC2410C, 0x0D757F, 0x7C3AED, 0xB4235A, 0x15803D].map { hex in
        Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
    static func avatar(for id: String) -> Color {
        avatars[Int(id.unicodeScalars.reduce(UInt32(7)) { ($0 &* 31) &+ $1.value } % UInt32(avatars.count))]
    }

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
