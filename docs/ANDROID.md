# Android

## App variants

Controlled by `APP_VARIANT` in `packages/app/app.config.js` (vanilla Expo, no custom Gradle plugin):

| Variant       | App name    | Package ID       |
| ------------- | ----------- | ---------------- |
| `production`  | Paseo       | `sh.paseo`       |
| `development` | Paseo Debug | `sh.paseo.debug` |

EAS profiles: `development`, `production`, and `production-apk` in `packages/app/eas.json`.

`development` uses Android `debug`.

## Local build + install

From repo root:

```bash
npm run android:development    # Debug build
npm run android:production     # Release build
npm run android:clear          # Remove generated Android project
```

Or from `packages/app`:

```bash
# Debug
APP_VARIANT=development npx expo prebuild --platform android --non-interactive
APP_VARIANT=development npx expo run:android --variant=debug

# Release
APP_VARIANT=production npx expo prebuild --platform android --non-interactive
APP_VARIANT=production npx expo run:android --variant=release

# Clear generated Android project
rm -rf android
```

## Screenshots

```bash
adb exec-out screencap -p > screenshot.png
```

## Windows real-device Expo validation

For clean-worktree Android dev-client validation on Windows, use the repo script from `packages/app`:

```powershell
npm run validate:windows-dev-client -- `
  --device-id f66d9150 `
  --port 8097 `
  --host lan `
  --env EXPO_NO_METRO_WORKSPACE_ROOT=1
```

What it does:

- optionally runs `npm run build:workspace-deps`
- starts Expo in the foreground and records `expo.log`
- clears proxy env for the Expo child unless `--keep-proxy-env` is set
- runs `adb reverse`, launches the dev-client deep link, and captures screenshot, UI dump, logcat, and top activity
- writes artifacts to a temp directory outside the checkout by default so the worktree stays clean

Exit codes are classification-oriented, not just process-oriented:

- `0` if the configured success text is visible in the dumped UI tree
- `2` if Android logcat shows a dev-client socket/read timeout
- `3` if `adb am start` fails to launch the target package
- `4` if artifacts were captured but no known success or failure signature was found

## Cloud build + submit (EAS)

Stable tag pushes like `v0.1.0` trigger:

- `packages/app/.eas/workflows/release-mobile.yml` on Expo servers (iOS + Android build + submit)
- `.github/workflows/android-apk-release.yml` on GitHub Actions (APK asset on GitHub Release)

Release candidate tags like `v0.1.1-rc.1` only trigger the GitHub APK workflow. They publish a GitHub prerelease APK for testing and do not submit to the stores.

### Useful commands

```bash
cd packages/app

# List recent workflow runs
npx eas workflow:runs --workflow release-mobile.yml --limit 10

# Inspect a run
npx eas workflow:view <run-id>

# Stream logs for a failed job
npx eas workflow:logs <job-id> --non-interactive --all-steps
```
