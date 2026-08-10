# Fork Release Pipeline

This is the low-plumbing path for maintaining a personal fork that carries local patches while still regularly pulling upstream changes.

## Required sequence

Always ship fork work in this order. Do not skip steps.

1. **Open a PR** from the feature branch into `main`.
2. **Merge the PR** into `main`.
3. **Release from `main`** by tagging the merge commit (or dispatching workflows with `checkout_ref` set to `main` / that merge SHA).

Rules:

- Never push a `v*` release tag from an unmerged feature branch.
- Never treat a local commit or feature-branch HEAD as the release target when `main` does not contain it yet.
- If you already pushed a tag too early, delete the tag and any half-built GitHub Release, merge the PR, then recreate the tag on the `main` merge commit and push it again.
- Version bumps for fork releases live in the tag / workflow inputs. Do not land package-version churn on the feature PR just to cut a release.

After the tag is on `main`, the usual tag-triggered workflows publish desktop, npm global-install, Docker, and Android artifacts. You can also dispatch those workflows manually with the same tag and `checkout_ref=main`.

## What The Fork Publishes

- Desktop installers and updater manifests are published to the fork's GitHub Releases.
- Docker daemon images are published to `ghcr.io/<fork-owner>/paseo`.
- npm global-install tarballs are published to the fork's GitHub Releases.
- The build stamps package versions inside CI from the release version you choose, so fork-only releases do not require committing package-version churn.

The desktop app's updater metadata is generated from the repository running the workflow. A build produced in `your-user/paseo` checks `your-user/paseo` for updates, not `getpaseo/paseo`.

By default, fork desktop builds keep the official desktop app ID (`sh.paseo.desktop`) so personal releases stay close to upstream. Override with `PASEO_DESKTOP_APP_ID` only when a fork intentionally needs a distinct app id.

## Version Choice

Use a monotonically increasing version in your fork.

Stable-channel example:

```text
v0.1.900
```

Beta-channel example:

```text
v0.1.105-beta.100
```

The release metadata parser currently supports stable `vX.Y.Z` and beta `vX.Y.Z-beta.N` tags. If you publish beta builds, set the desktop app's release channel to beta in settings. Stable-channel users only see stable tags.

## Desktop From GitHub UI

Run `.github/workflows/desktop-release.yml` with:

| Input           | Value                                    |
| --------------- | ---------------------------------------- |
| `tag`           | Your chosen version tag, e.g. `v0.1.900` |
| `platform`      | `all`, `macos`, `linux`, or `windows`    |
| `checkout_ref`  | The branch, tag, or SHA to build         |
| `publish`       | `true`                                   |
| `rollout_hours` | `0` for immediate personal rollout       |

The workflow creates or updates the GitHub Release in the fork and uploads installers plus Electron updater manifests.

### macOS Signing

If these secrets are present, macOS artifacts are signed and notarized:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

If they are missing, the workflow builds unnotarized macOS artifacts and applies an ad-hoc signature to the generated `.app` before DMG/zip packaging. Those builds are usable for personal testing with the normal macOS Gatekeeper bypass, including on Apple Silicon, but they are not a smooth public distribution experience. Public distribution still requires a real Developer ID signature and notarization.

## Docker Daemon Image From GitHub UI

Run `.github/workflows/docker.yml` on the branch you want to publish with:

| Input            | Value                                        |
| ---------------- | -------------------------------------------- |
| `paseo_version`  | The same version without `v`, e.g. `0.1.900` |
| `publish`        | `true`                                       |
| `publish_latest` | `false` for beta, optional for stable        |

The image is published as:

```text
ghcr.io/<fork-owner>/paseo:<version>
```

Use that image for remote daemon hosts when you want them to run the forked server code.

## npm Global Install Daemon From GitHub UI

If a remote host uses `npm install -g @getpaseo/cli`, publish forked npm tarballs to the same GitHub Release and install the CLI tarball URL instead of the upstream npm package.

Run `.github/workflows/npm-global-install-release.yml` on the branch you want to publish with:

| Input          | Value                                    |
| -------------- | ---------------------------------------- |
| `tag`          | Your chosen version tag, e.g. `v0.1.900` |
| `checkout_ref` | The branch, tag, or SHA to build         |
| `publish`      | `true`                                   |

Then install or update the daemon package on the Linux host:

```bash
npm install -g "https://github.com/<fork-owner>/paseo/releases/download/v0.1.900/getpaseo-cli-0.1.900.tgz"
```

The CLI tarball keeps the package name `@getpaseo/cli`, but its internal `@getpaseo/*` dependencies point at tarballs from the same GitHub Release. That means npm installs the forked daemon code without needing access to the upstream npm scope or a private package registry.

## Android APKs

Fork Android APKs are built locally in GitHub Actions, not on Expo Cloud. The workflow runs `expo prebuild`, applies the fork app identity, signs the generated Gradle release build, and uploads:

```text
paseo-vX.Y.Z-android.apk
```

Fork APKs default to the same product identity as official Paseo:

| Setting    | Value                 |
| ---------- | --------------------- |
| App name   | `Paseo`               |
| Package ID | `sh.paseo`            |
| URL scheme | `paseo`               |
| Updates    | Upstream EAS disabled |

That keeps package id, launcher name, deep-link scheme, and release asset names aligned with upstream so the fork APK can replace an existing official install. Override with `PASEO_ANDROID_PACKAGE_ID`, `PASEO_ANDROID_APP_NAME`, or `PASEO_URL_SCHEME` only when a fork intentionally needs a distinct brand.

Configure these repository secrets once for a secure, stable signing key:

| Secret                      | Value                                  |
| --------------------------- | -------------------------------------- |
| `ANDROID_KEYSTORE_BASE64`   | Base64 encoded `.jks` keystore         |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password                      |
| `ANDROID_KEY_ALIAS`         | Keystore alias, usually `paseo-upload` |
| `ANDROID_KEY_PASSWORD`      | Key password                           |

### Optional: mobile push for fork APKs

Fork APKs do **not** get push notifications unless you also configure Expo + Firebase for the APK package id (default `sh.paseo`). The local Gradle fork build path needs:

| Kind     | Name                          | Value                                                                |
| -------- | ----------------------------- | -------------------------------------------------------------------- |
| Variable | `PASEO_EXPO_PROJECT_ID`       | Expo project UUID (baked in as `extra.eas.projectId`)                |
| Variable | `PASEO_EXPO_OWNER`            | Expo account/org slug (optional; sets app `owner`)                   |
| Variable | `PASEO_EXPO_UPDATES_URL`      | EAS Update URL, e.g. `https://u.expo.dev/<project-uuid>` (optional)  |
| Secret   | `GOOGLE_SERVICES_FILE_BASE64` | Base64 of `google-services.json` for package `sh.paseo` (or your id) |

Expo project id / owner / updates URL are **not secrets** — store them as repository **Variables** (`Settings → Secrets and variables → Actions → Variables`). The workflow reads `vars.*` first and only falls back to `secrets.*` if you previously stored them as secrets.

```bash
gh variable set PASEO_EXPO_PROJECT_ID --repo <owner>/paseo -b '<expo-project-uuid>'
gh variable set PASEO_EXPO_OWNER --repo <owner>/paseo -b '<expo-username-or-org>'
gh variable set PASEO_EXPO_UPDATES_URL --repo <owner>/paseo -b 'https://u.expo.dev/<expo-project-uuid>'
base64 -w0 google-services.json | gh secret set GOOGLE_SERVICES_FILE_BASE64 --repo <owner>/paseo
```

You must still upload the **Firebase FCM service account** to that same Expo project (Expo dashboard / `eas credentials`). That server credential is separate from `google-services.json`. Without it, the APK may register an Expo token that never delivers.

If project id or google-services is missing, the fork APK still builds; the workflow warns and push will not work on that install.

If all four Android signing secrets are missing, the workflow still publishes an APK using the committed public insecure fallback key at `scripts/android-insecure-fallback-upload-keystore.jks.base64`. This is only a convenience path for fork smoke testing. Anyone with the repository can sign an APK with that public fallback key, so do not distribute fallback-signed APKs as trusted production builds.

Fallback-signed releases make the warning visible in two places:

- the APK asset name contains `INSECURE-PUBLIC-FALLBACK-KEY`
- a warning text asset is uploaded beside the APK

If only some Android signing secrets are configured, the workflow fails instead of falling back. Partial signing configuration usually means a fork owner intended to use secure signing but missed a secret.

Generic `vX.Y.Z` fork tags now publish the Android APK whether secure signing secrets are present or the fallback path is used. You can also dispatch `.github/workflows/android-apk-release.yml` with `tag` plus optional `checkout_ref` to rebuild a release from a branch without moving the tag.

## Web App Deploys

Generic `vX.Y.Z` fork tags skip the hosted web app deploy workflow. That avoids failing personal fork releases that do not have Cloudflare credentials configured. If you want to deploy the fork's hosted web app, push an `app-vX.Y.Z` tag or dispatch `.github/workflows/deploy-app.yml` with the required Cloudflare secrets available.

## Keeping Up With Upstream

Keep a long-lived branch for your fork changes, then regularly merge or rebase upstream `main` into it. After resolving conflicts and pushing the branch, run the desktop and Docker workflows again with a higher version.

The Browser localhost routing feature requires both sides to be updated:

- Desktop app built from the fork.
- Every host daemon, local or remote, running a fork build that advertises `server_info.features.tcpTunnel`. Use either the forked Docker image or the forked npm global-install tarball.
