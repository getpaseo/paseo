# KIN-001 evidence — inventory and toolchain (verified 2026-10-03, 2nd pass)

Owner: A0_LEAD. Branch: `task/KIN-001-inventory`.
Worktree note: this pass ran in an isolated worktree
(`/home/admin/projects/kin-wt-001`) so the KIN-002 lane's dirty tree in
`/home/admin/projects/kin` was never touched.

## Commands (all read-only, exit 0 unless noted)

- Package baseline re-run on Linux host: `python3 scripts/check_schedule_fixtures.py`
  (20/20), `check_watch_protocol.py` (18/18), `test_release_gate.py` (9/9),
  `node scripts/test_cloudflare.mjs` (12/12) → all PASS (reference checks only).
- `flutter --version` → 3.47.6 stable (Dart 3.13.5), installed from official
  `storage.googleapis.com` tarball to `~/flutter-sdk/flutter` (SHA via gcloud bucket;
  doctor below confirms integrity).
- `flutter doctor` → Flutter ✓, Android toolchain ✓ (SDK 36.0.0), Chrome ✓,
  network ✓; Linux desktop ✗ (clang/cmake missing — irrelevant for mobile);
  duplicate adb noted (`~/Android/Sdk` vs `/usr/lib/android-sdk`).
- Mac via ssh (non-invasive): Xcode 27.0/27A266a, iOS/Simulator SDK 27.0, Swift 6.4,
  macOS 27.0, Chrome w/ Default profile present (presence only), no Flutter/Node,
  no Android SDK → see `mac-toolchain-inventory.md`, `android-sdk-inventory.md`.
- `dart test/schedule_fixtures_test.dart` → 20/20 (recorded under KIN-003).

## Pinned so far

- Flutter stable 3.47.6 (framework rev 5fc346839b, engine b8c8d3d8), Dart 3.13.5.
- Android compile/target SDK: 36 (installed platforms 34/35/36, build-tools 35–37).
- AGP/Kotlin/Gradle: NOT pinned (no project yet — next: `flutter create` smoke build).

## Still unknown (founder input, no duplicates created)

Apple Team + ASC app/bundle IDs, Play account/package/signing, RevenueCat project/keys,
Cloudflare account/zone/routes, physical devices, legal/support identity, EUR-10 price
exactness. Recorded in `handoff/environment.local.md`.

## Second pass 2026-10-03 ~14:40 CEST (re-verification + Android build proof)

All commands read-only except the scratch APK build (writes confined to a
detached `/tmp` worktree, since removed; repo untouched).

- Reference checks re-run in this worktree, all PASS: schedule 20/20, watch
  protocol 18/18, release gate 9/9, Cloudflare worker 12/12 (reference only,
  no native proof — unchanged scope limitation).
- `flutter --version` (full path `~/flutter-sdk/flutter/bin/flutter`): 3.47.6
  stable, framework rev 5fc346839b, engine b8c8d3d8, Dart 3.13.5 — matches
  first pass, no drift.
- `flutter doctor`: Flutter ✓, Android toolchain ✓ (SDK 36.0.0), Chrome ✓
  (149.0.7827.155), network ✓, connected devices 3 (Pixel 7 Pro + linux +
  chrome); Linux desktop ✗ (clang/cmake missing — irrelevant for mobile).
- Android shell, clean-checkout proof: detached worktree at KIN-004 bootstrap
  commit `71482e9`, `flutter pub get --offline` + `flutter build apk --debug`
  → `✓ Built build/app/outputs/flutter-apk/app-debug.apk` (150 MB,
  Gradle `assembleDebug` 10.8 s, exit 0). First real phone-shell binary from a
  clean tree on this host.
- Physical device verified (new since first pass): `adb devices` →
  `28251FDH3003RS device` (usb, product cheetah); props: Google Pixel 7 Pro,
  Android 16, API 36. Install/launch deliberately NOT attempted — device
  ownership unverified, reserved for QA lane with owner approval.
- Mac re-checked via `ssh macbook` (presence/version only, nothing read):
  macOS 27.0 (26A428), Xcode 27.0 (27A266a), iPhoneOS SDK 27.0, Chrome
  `Default` profile dir exists, no flutter/node. Unchanged — still no browser
  controller attached; that verification belongs to KIN-031/A11 on the Mac.
- iOS shell: `flutter build ipa` is impossible on Linux; `ios/Runner.xcodeproj`
  is present in `71482e9` (static presence only). Mac-side build command for
  KIN-024/KIN-031 recorded in `toolchain-pin.md`.
- Seed integrity: `sha256sum -c SHA256SUMS.txt` → all package files OK except
  (a) `.gitignore` mismatch = our own tracked hardening (secret patterns added
  in scaffold `3d1bc22`, verified via `git diff c439169 HEAD`), and
  (b) 11 `infra/cloudflare/dist/*` entries absent = seal-time generated output
  that was never committed (gitignored, regenerable via
  `python3 scripts/build_site.py`). Evidence package sources in
  `/home/admin/.pandaos/uploads/` were only read, never written.
- Open deltas for lead (not changed here, other lanes own the files):
  bootstrap `minSdk` follows the Flutter default 24 while docs/13 proposes 26
  (decision + change belong to KIN-004/lead — founder 2nd round answered only
  the namespace part, minSdk still open); app namespace DECIDED by founder
  2026-10-03: `org.anpan.kin`, not `org.anpalahan.kin`. The code rename
  (namespace, applicationId, MainActivity path, iOS bundle) is KIN-004 lane
  work on its branch — recorded here, not renamed here.

Full version table with sources: `toolchain-pin.md`.

## Third pass 2026-10-03 ~16:40 CEST (review response + founder keep-going order)

Review asked for: commits + build logs present in the factory worktree (fixed —
this `handoff/evidence/KIN-001/` copy with `logs/` lives on branch
`team-6ffe9a-kin-001`); iOS half beyond a claim (built and logged below); Kin IDs
from real reads, never Breathe-and-Pray IDs (honored — the A11 Breathe-and-Pray
note on the Mac was not used as a Kin source); Mac Chrome controller
verification (still open after the browser attempt below).
Founder order: keep working without blocking him; missing devices are facts, not
blockers; Apple API key `AuthKey_9N9APUZP88.p8` may be used at runtime on the Mac
(short-lived JWT, helper pattern `.context/apple-review/asc.py`).

- Android build re-run with persisted log: detached scratch tree at `71482e9`,
  `flutter pub get --offline` + `flutter build apk --debug` → exit 0,
  `app-debug.apk` 143.5 MB. Full output: `logs/kin-android-build.txt`.
- Reference checks re-run with logs: schedule 20/20, watch 18/18, gate 9/9,
  Cloudflare worker 12/12, all exit 0 (`logs/kin-ref-*.txt`,
  `logs/kin-host-toolchain.txt`).
- iOS Simulator shell built on the Mac from a fresh archive of commit
  `71482e9` for `apps/mobile`, extracted to `/tmp/kin001-ios-clean/apps/mobile`.
  The official Flutter 3.47.6 macos-arm64 archive SHA-256 matched
  `a1946d3b6b3de15ce247dc89649df9035ce29e6b4e7ebe91919a25890ea2e79a`.
  `flutter pub get` and `flutter build ios --simulator --no-codesign` both
  exited 0; Xcode built `build/ios/iphonesimulator/Runner.app` in 24.6s.
  CocoaPods 1.17.0 and ffi 1.16.3 ran in a temporary Bundler directory because
  the Mac's system Ruby is 2.6.10; no global package was installed. The 26.5
  simulator runtime was available; no simulator was started and no signing or
  portal write occurred. The bootstrap's generated bundle ID is
  `org.anpalahan.kin`; it is source configuration, not a public Apple app ID,
  and does not replace the founder's `org.anpan.kin` decision owned by KIN-004.
  Full transcript: `logs/kin-ios-build.txt`.
- ASC read-only inventory: key file presence verified (`AuthKey_9N9APUZP88.p8`,
  mode 600, name only — material never read/copied); no `asc.py` helper exists
  on either host; Issuer ID is in no file on the Mac (full search logged in
  `logs/kin-mac-toolchain.txt`). Result: no JWT minted, no API call made.
  Exactly one fact missing: the Issuer UUID (App Store Connect → Users and
  Access → Integrations → Team Keys). Until then Apple IDs stay unknown — the Breathe-and-Pray IDs (Team BPQGF93XS4 etc.) seen in the founder message
  are explicitly NOT recorded as Kin IDs.
- RevenueCat / Play / Cloudflare: no credential or session offered on any
  reachable host; all stay unknown, no duplicates created anywhere.
- Mac Chrome controller: the available `browser_test` run navigated to
  `https://appstoreconnect.apple.com/apps` but ended at
  `/login?targetUrl=%2Fapps&authResult=FAILED` with `authReused: null`; a
  read-only snapshot showed only public footer links. This does not verify the
  founder profile or attachment to Chrome's `Default` profile. No credentials,
  cookies, sessions, or keys were read; the tab was closed and no portal data
  changed. The task workspace exposes no Chrome lease skill or command, so the
  authenticated-profile check remains for the authorized Mac lane. Run
  evidence: `evidence://wks_b4cfa92db3287952/evr_16c93210-ddb5-4a45-a8fb-045835a8c71e`.
