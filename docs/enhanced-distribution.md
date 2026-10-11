# Optional enhanced distribution

Build a separately identified local distribution with `APP_VARIANT=enhanced`. The default Expo and desktop release configurations retain the official Paseo identity.

The optional variant uses a gold V badge, the `paseo-enhanced` URL scheme and distinct application identifiers. Desktop stores its daemon under the enhanced application support directory and initializes a fresh daemon on loopback port 6791 without overwriting an existing configuration. The official daemon and its conversations are not migrated or restarted. Project files can still refer to the same filesystem paths; concurrent edits require the usual coordination.

## Local builds

Install the locked development dependencies first. On macOS, run `npm run build:desktop:local`. This uses an ad-hoc signed, non-notarized development build; production signing is a separate deployment decision. Enhanced updates are disabled by default so the official updater cannot replace this distribution.

For Android, set `ANDROID_HOME` and a compatible `JAVA_HOME`, then run `npm run build:android:enhanced`. The script generates the native project and creates an arm64 release APK. Configure a deployment signing key before distributing publicly. `npm run verify:android:enhanced -- <apk>` inspects package identity, provider scope, permissions, offline PDF resources and branding. Package inspection does not replace physical-device QA.

Enhanced cloud push registration requires its own Expo project and Google services configuration. Local task notifications use the existing OS notification bridge while the application is connected; delivery depends on system permissions and Focus/Do Not Disturb settings.

Run the specific tests relevant to your change. The helper scripts do not replace the repository CI policy. Keep local models, host configurations, conversation databases, APKs and private screenshots out of pull requests.
