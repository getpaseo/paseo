# KIN-001 Android SDK inventory (A4_ANDROID, Linux host, 2026-10-03)

READ-ONLY inventory. Nothing installed, no licenses accepted, SDK unmodified.

## Installed SDK packages (`sdkmanager --list_installed`, exit 0)

- platforms: android-34 (rev 3), android-35 (rev 2), android-36 (rev 2)
- build-tools: 35.0.0, 35.0.1, 36.0.0, 37.0.0
- platform-tools 37.0.1, emulator 37.2.12, cmake 3.22.1
- NDK (side-by-side): 27.0.12077973, 27.1.12297006, 28.2.13676358
- system-images: android-34 default x86_64 (rev 4) only

## Host toolchain

- JDK: OpenJDK 17.0.20.1 (Ubuntu 22.04, 64-bit)
- Gradle: NOT installed (`gradle: command not found`)
- Flutter/Dart: NOT installed (no `flutter`, no `android/` dir in kin repo yet)

## Pinnable versions (verifiable locally)

- compileSdk/targetSdk: 36 pinnable now (platform android-36 + build-tools 36.0.0 present).
  Matches docs/06 requirement (targetSdk >= 36 for Play submissions since 31.08.2026).
- AGP: NOT verifiable — no Gradle, no Flutter SDK, no android/ project to resolve it from.
- Kotlin: NOT verifiable — same reason.
- Pin AGP/Kotlin only after Flutter SDK lands and `flutter create`/`android/app/build.gradle` exists.

## Smoke-build readiness

- Flutter Android smoke build: NOT possible yet — Flutter SDK missing (blocker, owned by toolchain lane).
- Once Flutter SDK lands: yes, expected buildable — JDK 17 + platform-36 + build-tools 36.0.0 cover AGP 8.x requirements. No emulator image for API 35/36; only API-34 x86_64 image present, so API-36 device testing needs hardware or a new image.

## Addendum 2026-10-03 ~14:40 CEST (2nd pass)

- Flutter SDK present (`~/flutter-sdk/flutter`, 3.47.6) — the blocker above
  is resolved.
- Clean-checkout proof at KIN-004 bootstrap `71482e9` (detached `/tmp`
  worktree, since removed): `flutter build apk --debug` → exit 0,
  `app-debug.apk` 150 MB in 10.8 s Gradle time. Resolved versions: AGP 9.1.0,
  Kotlin 2.4.0, Gradle 9.3.1, NDK 28.2.13676358, compile/target 36
  (see `toolchain-pin.md`).
- Hardware present: Google Pixel 7 Pro, Android 16 (API 36), `28251FDH3003RS`
  over USB. API-36 device testing needs no new emulator image. No install or
  launch attempted (device ownership unverified).
