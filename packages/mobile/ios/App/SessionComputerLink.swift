import Foundation

/// `ComputerLink` over the relay: one `SessionLink` per paired computer, which
/// connects (relay hello, fresh hs1) on first use and again after the link
/// dropped. The local network path is not built yet.
actor SessionComputerLink: ComputerLink {
    private var links: [String: SessionLink] = [:]

    func call(_ command: SignedCommand, to computer: PairedComputer, signer: IdentitySigner) async throws -> CommandReply {
        let link = try await connected(computer, signer: signer)
        let r = try await link.call(command)
        return CommandReply(ok: r.ok, data: r.data, error: r.error)
    }

    func isPending(approvalId: String, on computer: PairedComputer, signer: IdentitySigner) async throws -> Bool {
        try await connected(computer, signer: signer).isPending(approvalId: approvalId)
    }

    private func connected(_ computer: PairedComputer, signer: IdentitySigner) async throws -> SessionLink {
        let link = links[computer.computerId] ?? SessionLink(computer: computer)
        links = [computer.computerId: link]
        try await link.connect(signer: signer)
        return link
    }
}
