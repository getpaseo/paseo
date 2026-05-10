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

## Cloud build + submit (EAS)

Stable tag pushes like `v0.1.0` trigger:

- `packages/app/.eas/workflows/release-mobile.yml` on Expo servers (iOS + Android build + submit)
- `.github/workflows/android-apk-release.yml` on GitHub Actions (APK asset on GitHub Release)

Beta tags like `v0.1.1-beta.1` only trigger the GitHub APK workflow. They publish a GitHub prerelease APK for testing and do not submit to the stores.

`android-v*` tags also trigger only the GitHub APK workflow — useful when you want to ship an APK without going through stores. Both workflows also support `workflow_dispatch`; the GitHub APK one takes an existing `tag` input so you can rebuild without cutting a new tag.

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
