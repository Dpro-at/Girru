// swift-tools-version:5.9
// Pure-Swift core of the iOS app (no UIKit), so it can be built and checked on
// any Mac with only the Command Line Tools: `swift run CoreChecks`. The Xcode
// app compiles the same files directly. No external dependencies.
//
// CoreChecks is a plain executable rather than an XCTest / Swift Testing
// target because the Command Line Tools ship neither XCTest nor the Swift
// Testing macro plugin.
import PackageDescription

let package = Package(
    name: "GirruCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "GirruCore", targets: ["GirruCore"])],
    targets: [
        .target(name: "GirruCore", path: "Sources/GirruCore"),
        .executableTarget(name: "CoreChecks", dependencies: ["GirruCore"], path: "Tests/CoreChecks"),
        // Pairs with a real computer and relay: packages/mobile/tools/pair-harness.mjs.
        .executableTarget(name: "PairCheck", dependencies: ["GirruCore"], path: "Tests/PairCheck"),
    ]
)
