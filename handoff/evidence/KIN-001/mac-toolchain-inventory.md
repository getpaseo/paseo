# KIN-001 Mac Toolchain Inventory

Date: 2026-10-03. Source: live `ssh macbook` read-only checks (A3_IOS, Mac half).

- macOS: 27.0 (Build 26A428)
- Xcode: 27.0 (Build 27A266a)
- iOS SDK: iphoneos 27.0; Simulator SDK: iphonesimulator 27.0
- Swift: Apple Swift 6.4 (swiftlang-6.4.0.34.1), target arm64-apple-macosx27.0.0
- Simulators: iOS 26.5 runtime present; devices (iPhone 17 Pro/Max/17/17e/Air, iPads) installed, all Shutdown
- Flutter: NOT installed on the Mac (`flutter: command not found`)

Verdict: iOS smoke build possible once Flutter SDK is installed (Xcode 27 + iOS 27 SDK cover the iOS 26.0 AlarmKit baseline; sim runtime 26.5 available).
