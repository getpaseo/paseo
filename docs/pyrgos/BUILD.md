# Building Pyrgos Paseo

Local builds only: no EAS cloud, no signing secrets. Hosts below are roles, not names.

| Host | Builds | Script |
|---|---|---|
| Lab (Linux) | Android debug + production APK | `scripts/pyrgos/build-android.sh` |
| Windows PC | Windows desktop installer | `scripts/pyrgos/build-desktop.ps1` |
| Windows PC (optional) | Android APK | `scripts/pyrgos/build-android.ps1` |

Every script has a twin (`.sh` / `.ps1`) with the same options.

## Android

```bash
scripts/pyrgos/build-android.sh [debug|production|both]   # default: both
```

Output: `$PYRGOS_APK_OUT` (default `artifacts/pyrgos/`, gitignored): `pyrgos-paseo-debug.apk`, `pyrgos-paseo-production.apk`. The production APK is a release build signed with a throwaway debug keystore (`~/.android/debug.keystore`, generated on first run, never committed). It is for sideloading over Tailscale, not for stores.

Environment (all optional):

| Variable | Meaning |
|---|---|
| `JAVA_HOME` | JDK 17-21. Android Studio's bundled JBR can be too new (25); the script then looks for `~/.local/jdk/jdk-21*`. |
| `ANDROID_HOME` | SDK root. Default `~/Android/Sdk` (Linux), `%LOCALAPPDATA%\Android\Sdk` (Windows). |
| `PYRGOS_ABIS` | `arm64-v8a` (default, phones) or `all`. |
| `PYRGOS_APK_OUT` | Output directory. |
| `EXPO_PUBLIC_LOCAL_DAEMON` | Daemon `host:port` baked into the JS bundle. |

### One-time setup on a fresh Linux host (user-level, no sudo)

1. JDK 21: download Temurin 21 (`https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse`) and unpack it to `~/.local/jdk/`.
2. SDK command-line tools: unpack Google's `commandlinetools-linux-*_latest.zip` to `~/Android/Sdk/cmdline-tools/latest/`.
3. ```bash
   export JAVA_HOME=~/.local/jdk/jdk-21*; export ANDROID_HOME=~/Android/Sdk
   yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
   $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
   ```
4. `npm ci` at the repo root. npm blocks some native-asset postinstalls (`allowScripts`); the build script runs the two Android needs (`react-native-enriched-markdown`, `@shopify/react-native-skia`) itself.

First build takes about 5-10 minutes and needs network (Gradle, RaTeX, Skia binaries).

### Smoke test

The script ends with `aapt2 dump badging` on each APK (package id, SDK levels). With a device or emulator: `adb install -r artifacts/pyrgos/pyrgos-paseo-debug.apk`. Package ids: `sh.paseo` (production variant, both APKs).

## Windows desktop installer

Not built on the lab. On the Windows PC:

```powershell
scripts/pyrgos/build-desktop.ps1
```

Runs `npm ci` and `npm run build:desktop` (Expo web export, then electron-builder). Output: `packages/desktop/release/` (gitignored). Needs Node 22 and the Windows build prerequisites for native modules (Visual Studio Build Tools). Copy the installer out of the repo to distribute. `build-desktop.sh` is the same flow for a Linux/macOS host.

### PC-CHECK (untested on PC)

```powershell
node -v                                   # v22.x
scripts/pyrgos/build-desktop.ps1          # exit 0; lists an installer .exe and latest.yml
Test-Path packages/desktop/release/*.exe  # True
```

Optional APK build on the PC: set `JAVA_HOME` (JDK 21) and `ANDROID_HOME`, then `scripts/pyrgos/build-android.ps1 debug`; expect `pyrgos-paseo-debug.apk` in `artifacts/pyrgos`. The `.ps1` Android twin was run under `pwsh` on the lab (exit 0, identical APK size); the Windows-specific paths (`gradlew.bat`, `%LOCALAPPDATA%`) are untested.
