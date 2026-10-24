// swift-tools-version:5.9
// The Overhand menu bar item on a Mac: a helper the daemon starts (packages/core/src/menubar.ts). `bun run menubar` builds it.
import PackageDescription

let package = Package(
  name: "overhand-menubar",
  platforms: [.macOS(.v13)],
  targets: [.executableTarget(name: "overhand-menubar", path: "Sources/OverhandMenubar")]
)
