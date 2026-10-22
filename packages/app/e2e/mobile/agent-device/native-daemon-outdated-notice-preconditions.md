# Native daemon-outdated notice

The flow needs the development app connected to an isolated daemon older than the app. Install a published daemon that predates `terminalsSurviveRestart`, start it in its own home, and bundle the app against it. `<checkout>` is the root of this repository; `<port>`, `<metro-port>` and `<udid>` are a free daemon port, a free Metro port and the booted simulator.

Run this once, in any directory. It installs into `/tmp/old-daemon`, not globally:

```sh
npm install --prefix /tmp/old-daemon --no-package-lock @getpaseo/server@0.8.0
```

Terminal 1, the old daemon. It runs in the foreground; keep it running:

```sh
cd /tmp/old-daemon/node_modules/@getpaseo/server
PASEO_HOME=/tmp/old-daemon-home PASEO_LISTEN=0.0.0.0:<port> PASEO_RELAY_ENABLED=0 node dist/scripts/supervisor-entrypoint.js
```

Terminal 2, Metro. It runs in the foreground; keep it running:

```sh
cd <checkout>/packages/app
APP_VARIANT=development EXPO_PUBLIC_LOCAL_DAEMON=localhost:<port> npx expo start --port <metro-port> --clear
```

Terminal 3, the flow, while terminals 1 and 2 are still running:

```sh
cd <checkout>
xcrun simctl openurl <udid> "paseo://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A<metro-port>"
maestro --udid <udid> test packages/app/e2e/mobile/agent-device/native-daemon-outdated-notice.ios.yaml --env DAEMON_VERSION=0.8.0
```

Start with the sidebar closed. The flow opens it, then asserts the notice, its daemon version, the terminals line for a daemon without `terminalsSurviveRestart`, and an enabled Update button. Do not tap Update: on 0.8.0 it runs a global `npm install -g @getpaseo/cli@latest`.

When you are done, stop terminals 1 and 2 and remove `/tmp/old-daemon` and `/tmp/old-daemon-home`.
