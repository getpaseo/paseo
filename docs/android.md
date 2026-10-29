# Android

## App variants

Controlled by `APP_VARIANT` in `packages/app/app.config.js` (vanilla Expo, no custom Gradle plugin):

| Variant       | App name    | Package ID       |
| ------------- | ----------- | ---------------- |
| `production`  | Paseo       | `sh.paseo`       |
| `development` | Paseo Debug | `sh.paseo.debug` |

EAS profiles: `development`, `production`, and `production-apk` in `packages/app/eas.json`.

`development` uses Android `debug`.

## Version codes

`packages/app/native-release-version.js` is the single definition of native and F-Droid version-code math. Do not re-derive these numbers anywhere else — a drifted copy produces changelog files that match no published APK, and nothing fails loudly.

The base version code comes from the package version:

```text
major * 1_000_000 + minor * 1_000 + patch
```

Prerelease metadata is ignored, so `0.1.102-beta.1` and `0.1.102` both produce `1102`. The same value is used as the iOS `buildNumber` because `packages/app/eas.json` uses EAS's local app version source. Do not re-enable EAS remote version counters or Android `autoIncrement`; F-Droid and other source-based builders need the native build number to be visible in the repo.

The formula reserves three digits each for minor and patch. If either reaches `1000`, change the formula before cutting that release.

## Prerequisites (local dev)

Local Android builds run on macOS (or Linux) and need the Android toolchain, pinned in `.tool-versions` (`java 21`, `android-sdk 21.0`) and wired up by `.mise.toml` (which derives `ANDROID_HOME` and the command-line tool paths from the `android-sdk` entry). With [mise](https://mise.jdx.dev):

```bash
mise install        # java 21 + android-sdk 21.0 command-line tools
```

> **Pin a real `android-sdk` version, not `latest`.** The mise `android-sdk` plugin's `latest` resolved to the ancient `1.0` bundle, whose `sdkmanager` (3.6.0) predates the `emulator` package and fails with `Failed to find package emulator`. `21.0` ships a current `sdkmanager`. If you bump it, update only the version in `.tool-versions`; `.mise.toml` derives its paths from that tool entry.

`mise install` only lays down the command-line tools. Install the rest and create an emulator. On Apple Silicon:

```bash
sdkmanager --licenses
sdkmanager "platform-tools" "emulator" "platforms;android-35" "build-tools;35.0.0" \
           "system-images;android-35;google_apis;arm64-v8a"
avdmanager create avd -n paseo -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_7
emulator @paseo     # start it; leave running
```

On an Intel Mac, use the `x86_64` system image:

```bash
sdkmanager --licenses
sdkmanager "platform-tools" "emulator" "platforms;android-35" "build-tools;35.0.0" \
           "system-images;android-35;google_apis;x86_64"
avdmanager create avd -n paseo -k "system-images;android-35;google_apis;x86_64" -d pixel_7
emulator @paseo     # start it; leave running
```

Gradle auto-fetches the platform/build-tools it needs once licenses are accepted, so adjust `android-35` only if it asks for a different level.

## Local build + install

The locked `expo-modules-core@57.0.23` needs the patch installed by `npm install`.
It backports
[Expo's Activity-result launcher fix](https://github.com/expo/expo/pull/49634): changing
font size or another unhandled configuration can otherwise disable image selection
until the app process restarts. Rebuild the native app after changing this patch;
a Metro reload cannot update it. Remove the patch when the installed
`expo-modules-core` includes the fix.

Run its native regression tests from `packages/app/android` after prebuild:

```bash
./gradlew :expo-modules-core:testDebugUnitTest \
  --tests expo.modules.kotlin.activityresult.AppContextActivityResultRegistryRecreationTest \
  --no-daemon --max-workers=1 -Dorg.gradle.parallel=false
```

From repo root:

```bash
npm run build:apk       # Universal dogfood APK: 32/64-bit ARM and x86
npm run build:apk:arm64 # Smaller dogfood APK for ARM64 phones
npm run dev:android     # Build/install the debug app and start development
npm run dev:ios         # Build/install the iOS development app
```

`build:apk` writes `artifacts/paseo-dogfood-universal.apk`; `build:apk:arm64` writes
`artifacts/paseo-dogfood-arm64.apk`. Neither command launches or installs on a device. Both enable
`PASEO_WATCHDOG_BUILD=1`, the production React profiling renderer, and Android's shell-profileable
flag. These builds keep the production package ID (`sh.paseo`) and release optimizations. Use this APK for
personal dogfooding. Android system-trace spans require the separate `PASEO_PROFILE_BUILD=1` flag;
watchdog recording does not send duplicate spans to that sink by default. Normal store/release
workflows leave diagnostics disabled.

The older `android`, `android:development`, and `ios` commands remain aliases for development.
`android:production` still builds and installs a release through Expo; use `build:apk` when you
need an artifact. `android:clear` removes the generated Android project.

Run `npm run test:android --workspace=@getpaseo/app` explicitly with a local Android toolchain to prebuild Android and run native module unit tests. Ordinary CI does not prebuild Android or run these tests.

### Diagnostic logs without ADB

In a dogfood build, open Android's Files app → Downloads → **Paseo diagnostics** and share all
retained `.jsonl` files. No app screen, storage permission, or attached debugger is required.
The recorder retains eight files of about 5 MiB each across reconnects and app restarts. Rotation
replaces the oldest files, so collect them soon after reproducing a freeze. Uninstall/reinstall
can leave older Downloads files that the new installation cannot manage.

Each file identifies its build and session. Events include application-transport frame sizes and
message/request IDs, connection transitions, parse/validation/dispatch spans, named React subtree
render timings, and foreground JS heartbeat gaps. Payloads, passwords, and message contents
are excluded; connection identifiers include host addresses. Each size has a unit: **bytes** when
already available, otherwise **UTF-16 code units** for text. These are
client transport observations, after relay decryption where applicable, not packet arrival times.

The native recorder flags a heartbeat overdue by more than 500 ms (250 ms expected interval).
A heartbeat gap bounds the unresponsive interval; it is not an exact blocked-stack duration.
Backgrounding suspends detection. `js.stall.started` can be written while JS remains blocked;
`js.stall.recovered` records the gap when JS resumes. Recovery can appear without a start event
when JS resumes before the next native sampling tick. Process death leaves earlier files intact,
but queued/unflushed records can be lost. A missing recovery event alone does not prove a crash.

`react.render.slow` records subtree rendering taking at least 16 ms; one-second summaries include
faster renders. Nested profiler timings overlap: don't add parent and child times. React's render
measurements do not measure native layout/paint or the complete commit phase. `recorder.dropped`
means the bounded queue overflowed; missing events in that interval must not be treated as absence
of activity. Storage failure stops recording rather than blocking the app.

For an ordinary release APK with system trace markers only:

```bash
PASEO_PROFILE_BUILD=1 npm run android:production
```

Those markers emit only while a system trace records `sh.paseo` (`perfetto -a sh.paseo ...`);
they do not produce Downloads files.

## Running on an emulator against a worktree daemon

`npm run android` builds and installs the dev client, but two connections have to reach your Mac from inside the emulator — Metro (the JS bundle) and the Paseo daemon — and **the emulator does not share the host's loopback**: `localhost` inside the emulator is the emulator itself. Reach the host at `10.0.2.2` (the standard AVD's host alias) for both:

```bash
REACT_NATIVE_PACKAGER_HOSTNAME=10.0.2.2 \
  EXPO_PUBLIC_LOCAL_DAEMON=10.0.2.2:$PASEO_SERVICE_DAEMON_PORT \
  npm run android
```

- **`REACT_NATIVE_PACKAGER_HOSTNAME=10.0.2.2`** — without it, Expo bakes your Mac's LAN IP into the dev client's Metro URL, which the emulator can't route to, and the app dies with `Failed to connect to /<lan-ip>:8081` before any JS loads.
- **`EXPO_PUBLIC_LOCAL_DAEMON=10.0.2.2:<port>`** — the client's daemon endpoint (`packages/app/src/runtime/host-runtime.ts`); when unset it defaults to `localhost:6767`, the production daemon. Use `$PASEO_SERVICE_DAEMON_PORT` for a worktree daemon running as a Paseo service, or `6768` for a standalone `npm run dev:server`. It is inlined into the JS bundle at Metro bundle time, so set it on the build command and clear the Metro cache (`npx expo start -c`) if a change doesn't take.

**Alternative — `adb reverse` + `localhost`** (if `10.0.2.2` misbehaves):

```bash
adb reverse tcp:8081 tcp:8081
adb reverse tcp:$PASEO_SERVICE_DAEMON_PORT tcp:$PASEO_SERVICE_DAEMON_PORT
REACT_NATIVE_PACKAGER_HOSTNAME=localhost \
  EXPO_PUBLIC_LOCAL_DAEMON=localhost:$PASEO_SERVICE_DAEMON_PORT \
  npm run android
```

This is the Android counterpart of the iOS local-simulator flow in [development.md](development.md): on iOS the simulator shares the Mac's loopback so `localhost:<port>` works directly; on Android you need `10.0.2.2` or `adb reverse`.

## Inverted timeline selection

Android focus and selection visibility requests must not reposition inverted timelines. The
`modules/paseo-scroll` package keeps React Native's scroll manager interface and returns zero for
child-reveal scroll calculations when the view's transform matrix inverts the vertical axis. React
Native's Android list uses `scale: -1`, which decomposes into a 180-degree rotation with positive
`scaleY`; checking the scale property alone misses it. Dragging and explicit scroll
commands still work; non-inverted scroll views keep Android's default behavior.

Register this package before React Native's core package through its Expo config plugin. Normal
Android builds use the prebuilt `react-android` library, so patching Java under `node_modules` does
not change the shipped scroll view. Keep this behavior in the app's compiled native module.

## F-Droid / source-only Android builds

F-Droid builds should set `PASEO_FDROID_BUILD=1` when running Expo prebuild:

```bash
cd packages/app
PASEO_FDROID_BUILD=1 APP_VARIANT=production npx expo prebuild --platform android --clean --non-interactive
cd android
PASEO_FDROID_BUILD=1 ./gradlew assembleRelease --no-daemon --max-workers=1 -Dorg.gradle.parallel=false
```

The flag must be present for both prebuild and Gradle because Gradle starts Metro for the release bundle. Keep the source build serial and daemon-free as shown above: compiling every Expo module can exhaust memory when Gradle workers run in parallel. The profile enables source-built Expo modules, excludes the proprietary camera, Firebase notification, and Expo development-client native modules, disables Gradle dependency metadata, and substitutes JavaScript stubs for camera and notifications. The resulting app supports direct and pasted-link pairing but not QR scanning or push notifications.

For a single-ABI APK, pass React Native's architecture property to Gradle:

```bash
PASEO_FDROID_BUILD=1 ./gradlew assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  --no-daemon --max-workers=1 -Dorg.gradle.parallel=false
```

Supported values are `armeabi-v7a`, `arm64-v8a`, `x86`, and `x86_64`. The F-Droid profile filters native libraries to that ABI and changes the APK version code to `baseVersionCode * 10 + abiSuffix`, where the suffixes are ordered `1` through `4` in that same sequence. F-Droid metadata should use four build blocks with `VercodeOperation` entries `10 * %c + 1` through `10 * %c + 4` and pass the matching `reactNativeArchitectures` value in each build command. Builds without a single architecture keep the base version code.

Keep the excluded npm packages installed. Normal builds use them, while the F-Droid profile removes only their Android native modules and config plugins. Paseo always applies `expo-gradle-jvmargs` with `-Xmx4096m` and `-XX:MaxMetaspaceSize=1024m` so local Expo prebuilds have enough Gradle heap whether they use precompiled AARs or source-built Expo modules.

The EAS `production-apk` profile uses the large Android resource class. Release builds compile the native ABIs and run Hermes bundling in the same Gradle invocation; the default worker can exhaust its remaining memory and kill Hermes with exit code 137 even when Gradle's own heap is correctly sized.

### F-Droid store metadata

F-Droid reads the store listing from `fastlane/metadata/android/<locale>/` **at the repo root**. This location provides the best compatibility with the F-Droid release process.

```text
fastlane/metadata/android/
├── en-US/                      (F-Droid fallback locale, mandatory)
│   ├── title.txt               (<=50 chars)
│   ├── short_description.txt   (<=80 chars)
│   ├── full_description.txt    (<=4000 chars, limited HTML)
│   ├── images/
│   │   ├── icon.png            (512x512)
│   │   ├── featureGraphic.png  (1024x500)
│   │   ├── phoneScreenshots/   (1.png, 2.png, ... linked to the store renders)
│   │   └── tenInchScreenshots/ (1.png, 2.png, ... linked to the store renders)
│   └── changelogs/             (generated — see below)
├── ja/
└── zh-CN/
```

Locale directories generally match `packages/app/src/i18n/locales.ts`, but note that `en` becomes `en-US`.

Google Play reads its screenshots from the same folders; see [Store screenshots](release.md#store-screenshots).

F-Droid changelogs are generated from `CHANGELOG.md`. Run `npm run fdroid:changelogs`; `npm run fdroid:changelogs:check` verifies without writing. It is wired into the npm `version` lifecycle, so a release picks it up automatically and `git add -A` stages the result.

One changelog must be generated per-ABI-split, so each version will create **four** identical version-coded entries. F-Droid caps changelogs at 500 characters, so the generator strips some content and adds a link to the full notes.

Stable sync fails loudly if `CHANGELOG.md` has no entry for the version being cut. That is intentional — the release checklist requires the entry to be committed first, so an abort here means the checklist was skipped.

Because the generator runs off the version in `package.json`, it must run **before** the tag is created: fdroidserver only reads metadata from the tag it builds, so the file for version N has to exist in the commit N points at.

Beta releases are an explicit no-op: they do not create or rewrite F-Droid changelog files. Stable releases and promotions generate the four ABI entries from their final changelog.

### React version lockstep

Keep `react` and `react-dom` pinned to the React version embedded by the current `react-native` release. React Native `0.81.x` embeds `react-native-renderer` `19.1.0`, so `packages/app` must use React `19.1.0`. Bumping React to a newer patch can build successfully but crash at JS startup on Android with `Incompatible React versions`, leaving the app on the native splash screen.

## Screenshots

```bash
adb exec-out screencap -p > screenshot.png
```

## Cloud build + submit (EAS)

Stable tag pushes like `v0.1.0` trigger:

- The EAS GitHub app on Expo servers, using `packages/app/.eas/workflows/release-mobile.yml` (iOS + Android production builds and distribution).
- `.github/workflows/android-apk-release.yml` on GitHub Actions (APK asset on GitHub Release).

iOS distributes the same build to external TestFlight testers and App Store review; see [Mobile builds (EAS)](release.md#mobile-builds-eas) for the review paths. Android auto-submits to the Play Store via EAS-managed credentials.

Beta tags like `v0.1.1-beta.1` trigger the GitHub APK workflow and EAS `Release iOS Beta`. They publish a GitHub prerelease APK and distribute iOS through TestFlight without submitting to production stores.

`android-v*` tags also trigger only the GitHub APK workflow — useful when you want to ship an APK without going through stores. The GitHub APK workflow supports `workflow_dispatch` with an existing `tag` input so you can rebuild without cutting a new tag.

### Useful commands

```bash
cd packages/app

# Recent builds
npx eas build:list --limit 10 --non-interactive --json | jq '.[] | {platform, status, appVersion, gitCommitHash}'

# Inspect a build (the printed `Logs` URL opens the build's Expo dashboard page,
# which has a Submissions section showing the auto-submit to the Play Store).
npx eas build:view <build-id>
```

The Play Console (Internal testing → Production tracks) is the final confirmation that the binary reached the store.

See [docs/release.md](release.md) for the full mobile-build babysitting flow.
