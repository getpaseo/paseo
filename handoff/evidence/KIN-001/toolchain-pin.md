# KIN-001 toolchain pin (verified 2026-10-03, 2nd pass)

Jointly compiling set: Flutter stable drives the Android versions below;
Xcode 27 covers the iOS 26.0 AlarmKit baseline per docs/13. Each value names
its source. Nothing here was invented — unverifiable entries stay UNPINNED.

## Pinned

| Component                          | Version                                               | Source                                                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Flutter                            | 3.47.6 stable (framework 5fc346839b, engine b8c8d3d8) | `flutter --version`, `~/flutter-sdk/flutter`                                                                                                                 |
| Dart                               | 3.13.5                                                | same                                                                                                                                                         |
| Android compileSdk / targetSdk     | 36                                                    | Flutter 3.47.6 defaults (`FlutterExtension.kt`: `compileSdkVersion = 36`, `targetSdkVersion = 36`); platform android-36 rev 2 + build-tools 36.0.0 installed |
| Android minSdk (bootstrap default) | 24                                                    | Flutter default; docs/13 proposes 26 — open lead decision, change belongs to KIN-004                                                                         |
| NDK                                | 28.2.13676358                                         | Flutter default; installed (side-by-side 27.0/27.1/28.2)                                                                                                     |
| AGP                                | 9.1.0                                                 | `apps/mobile/android/settings.gradle.kts` at KIN-004 bootstrap `71482e9`                                                                                     |
| Kotlin                             | 2.4.0                                                 | same                                                                                                                                                         |
| Gradle                             | 9.3.1                                                 | `gradle-wrapper.properties` at `71482e9`; dist cached in `~/.gradle`                                                                                         |
| JDK                                | OpenJDK 17.0.20.1 (Ubuntu 22.04)                      | `java --version` on Linux host                                                                                                                               |
| Xcode / iPhoneOS SDK               | 27.0 (27A266a) / 27.0                                 | `xcodebuild -version`, `xcrun --show-sdk-version` via `ssh macbook`                                                                                          |
| Swift                              | 6.4 (first pass; re-verify on Mac before pinning use) | first-pass record, not re-checked this pass                                                                                                                  |
| macOS (build host)                 | 27.0 (26A428)                                         | `sw_vers` via `ssh macbook`                                                                                                                                  |
| Node (Linux device-farm host)      | v22.23.0                                              | `node --version`                                                                                                                                             |
| Python (Linux host)                | 3.10.12                                               | `python3 --version`                                                                                                                                          |
| Chrome (Linux host)                | 149.0.7827.155                                        | `flutter doctor`                                                                                                                                             |
| adb                                | 1.0.41 (28.0.2-debian) + SDK platform-tools 37.0.1    | `adb version`; duplicate-binary warning noted, SDK copy used by Flutter                                                                                      |

## Verified against this pin

- `flutter build apk --debug` at `71482e9` in a detached scratch worktree:
  exit 0, `app-debug.apk` 150 MB, Gradle `assembleDebug` 10.8 s.
- `flutter doctor`: Android toolchain ✓, 3 connected devices
  (Pixel 7 Pro / linux / chrome).

## Unpinned / Mac-side only

- iOS archive (`flutter build ipa`): must run on the Mac; needs signing
  identity from portal inventory (KIN-028) — owner KIN-024/KIN-031.
- Ruby/fastlane on Mac: never checked (no approved Mac command channel for
  writes yet); needed before signed lanes run.
- Browser controller attached to the founder's Chrome `Default` profile:
  presence of the profile dir verified, capability NOT verified (KIN-031/A11).
- Store-facing IDs: app namespace DECIDED `org.anpan.kin` (founder 2026-10-03,
  code rename pending in KIN-004 lane). Apple Team, Play account/package/
  signing, RevenueCat project/keys, Cloudflare account/zone still unknown;
  `config/integrations.example.json` reviewed — every ID field is null,
  no duplicates created.
