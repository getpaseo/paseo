# KIN-001 Mac Toolchain Inventory

Date: 2026-10-03. Source: live `ssh macbook` read-only checks (A3_IOS, Mac half).

- macOS: 27.0 (Build 26A428)
- Xcode: 27.0 (Build 27A266a)
- iOS SDK: iphoneos 27.0; Simulator SDK: iphonesimulator 27.0
- Swift: Apple Swift 6.4 (swiftlang-6.4.0.34.1), target arm64-apple-macosx27.0.0
- Simulators: iOS 26.5 runtime present; devices (iPhone 17 Pro/Max/17/17e/Air, iPads) installed, all Shutdown
- System Ruby: 2.6.10; CocoaPods was not installed globally.
- Flutter 3.47.6 was unpacked to `/tmp/kin001_flutter_sdk/flutter` for this
  verification. The downloaded archive matched the official SHA-256 recorded
  in `toolchain-pin.md`.
- CocoaPods 1.17.0 and ffi 1.16.3 were installed under `/tmp/kin001-bundle`
  through Bundler. Nothing was installed globally.

Verdict: The iOS Simulator shell built successfully from a clean `71482e9`
snapshot using `flutter build ios --simulator --no-codesign`. Xcode 27 and the
iOS 26.5 simulator runtime were present; no signing or simulator launch was
needed. Full output: `logs/kin-ios-build.txt`.
