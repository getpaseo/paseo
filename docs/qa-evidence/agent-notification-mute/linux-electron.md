# Linux Electron notification QA

Tested source: `0c92e3dcc6e421dd356af7a1bcbe5dc9edebfe1a` on Ubuntu 20.04 x64,
Node 22.22.3, and the repository's pinned Electron 44.2.0. This automated smoke
used a temporary daemon and desktop profile, a private Xvfb display, and a private
D-Bus session. The existing fake agent provider supplied deterministic turns and
permission requests; the renderer, preload, IPC, and Electron notification backend
were real.

The private `org.freedesktop.Notifications` receiver recorded actual `Notify`
calls. Each positive check matched the received title and body to the daemon's
notification payload. Negative checks waited 1.5 seconds after completion attention.

| Action                                                          | Notification-service result                                                |
| --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Complete a turn while viewing another agent                     | `Agent finished` / `Hello world`                                           |
| Select **Mute completion alerts**, then complete another turn   | No additional call                                                         |
| Request permission while still muted                            | `Agent needs permission` / `Permission required - Test permission request` |
| Allow the request and finish that turn                          | No additional call                                                         |
| Select **Unmute completion alerts**, then complete another turn | `Agent finished` / `Hello world`                                           |

The driver acknowledged prior unread completion attention between turns, matching
the daemon's existing attention deduplication policy. Both toggles went through
the real tab context menu, and label updates were read back from the daemon.

Commands used, from the checkout with Node 22 on `PATH`:

```sh
npm run build:main --workspace=@getpaseo/desktop
dbus-run-session -- node node_modules/tsx/dist/cli.mjs --tsconfig packages/app/tsconfig.json /tmp/paseo-mute-desktop-qa/smoke.mts
```

The temporary QA driver and D-Bus receiver are outside the source tree. The driver
uses `createTestPaseoDaemon` and `DaemonClient` from the existing test utilities,
launches the real desktop package with Playwright Electron, and drives the actions
in the table. Xvfb dependencies were extracted into its temporary runtime without
a system installation.

- [Runner result and received notification payloads](linux-electron-result.json)
- [Electron interaction recording](linux-electron.webm)
- [Muted menu](linux-electron-muted.png)
- [Unmuted menu](linux-electron-unmuted.png)

This verifies Linux notification-service delivery, not visible popup rendering,
notification clicks, phone push delivery, or native macOS, Windows, iOS, or Android
behavior. React development warnings about existing DOM accessibility props were
logged during navigation; the notification assertions passed.
