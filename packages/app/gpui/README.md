# Experimental GPUI client

Run Paseo's existing React Native app in a native GPUI window on Linux. This is
a community starting point: the real workspace UI runs, but terminal/diff
renderers and several native services still need porting. The normal desktop
build remains Electron. No daemon changes or release installers are included.

## Run it

Start from the repository's [development setup](../../../docs/development.md).
A fresh checkout needs the root dependencies and workspace build outputs:

```sh
npm ci
npm run build:server
npm run gpui:install
EXPO_PUBLIC_LOCAL_DAEMON=localhost:6768 npm run dev:gpui
```

Use an already-running compatible daemon and replace `localhost:6768` with its
endpoint. These GPUI commands never start or restart a daemon. The address is
inlined at bundle time. The app's normal connection/authentication rules apply.

You also need Rust stable through rustup, CMake, Ninja, Clang, Linux X11/Wayland
development libraries, and Vulkan. The tested Linux x86_64 host already had
most build tools; it additionally needed `libxkbcommon-x11-dev`. A clean-machine
prerequisite check is still needed. The first native build downloads dependencies
and builds Rust/C++; allow several minutes and several GB of disk.

`dev:gpui` bundles the app, autolinks native modules, builds, and opens the window.
Restart after editing. It uses an offline production JS bundle; Fast Refresh is
not wired into this launcher. `build:gpui` builds without opening a window.
`gpui:bundle -- --dev false` only writes the JS bundle, source map, and assets to
`.artifacts/gpui/`. Bundle validation checks that the real routes are present and
that no `react-native-webview` modules were included.

## Approach and renderer choice

```text
Existing Paseo RootApp + Expo Router + state/client/plugin code
                         |
                  React in Hermes
                         |
               React Native Fabric
                         |
              Rust GPUI native renderer
                         |
                  Linux GPU window

Existing Paseo client <-- WebSocket --> separately running Node daemon
```

The separate npm project is deliberate: the selected runtime uses RN 0.87.1,
while Paseo's mobile app uses RN 0.86.3. Metro redirects native dependencies to
that installation and resolves the rest from the app. This avoids changing the
mobile dependency baseline just to try another renderer. It also creates a
version-maintenance cost that needs testing before this becomes a supported target.

The choice was to preserve the existing app's RN component and library contracts:

| Candidate                                                                                                                           | Integration model                                                                                                | Consequence for this experiment                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Streetwriters react-native-gpui](https://github.com/streetwriters/react-native-gpui/tree/de11aa265e6fb36c80e8a30315bce6d34a9be7d6) | React Native Fabric, Hermes, and GPUI, with ports of screens, gestures, Reanimated/worklets, safe areas, and SVG | Chosen because it lets the existing RN app reach a real Linux window with targeted adapters. These ports are still experimental.                                                                                                 |
| [natew/react-native-gpui](https://github.com/natew/react-native-gpui/tree/b2254543357f02fdd983d0d8a584d1d1bd93f5da)                 | Custom React reconciler with an RN-like component surface; its README targets macOS arm64/Metal                  | Useful implementation reference. Running this Linux app would also require platform work and compatibility with the RN libraries it imports.                                                                                     |
| [GPUIX](https://github.com/remorses/gpuix)                                                                                          | Custom React/Solid renderer, its own JSX primitives, and Node-API native bindings; supports Bun/Node execution   | Also native GPUI, with interesting packaging and specialized surfaces. Adopting it would require replacing or adapting Paseo's RN component/library contracts. It remains an alternative worth testing, not a rejected renderer. |
| Existing Electron target                                                                                                            | RN Web inside Chromium, with the desktop host bridge                                                             | Preserves the working desktop feature set, but does not answer the experiment's question of running the app through a native renderer.                                                                                           |

This is an integration choice, not a performance comparison. There are no
controlled CPU, memory, startup, or frame-time results against these alternatives.

## What belongs in the change

| Area                                                                   | Why it is here                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vendor/react-native-gpui/`                                            | Editable, pinned runtime source. This accounts for roughly 130,000 lines of the diff. GitHub marks it as vendored; inspect [UPSTREAM](../../../vendor/react-native-gpui/UPSTREAM) for provenance and the two local patches. |
| npm and Cargo lockfiles                                                | Reproduce the experiment's dependencies. Roughly 15,000 generated lines, collapsed on GitHub.                                                                                                                               |
| `desktop/`, `index.js`, `routes.js`, Metro/Babel config, root launcher | Register the full app, select the native runtime, compile native services, and bundle the actual route graph. The explicit route context prevents an apparently successful build with no app routes.                        |
| `adapters/`                                                            | Desktop implementations of the app-used APIs, plus explicit unavailable-capability implementations for mobile features. About 700 lines; these are limited ports, not complete replacements for Expo/Unistyles.             |
| Shared app edits                                                       | One capability gate for alpha-mask shimmer. GPUI shows the logo and labels without that effect. Existing web/iOS/Android paths keep their behavior.                                                                         |
| Native tests and this guide                                            | Make the working slice reproducible and give contributors bounded follow-up work.                                                                                                                                           |

Upstream examples, its tester/testing package, website, unused fonts/vector-icon
ports, starter navigation dependencies, sample icon, and unused nested Cargo config
are omitted. Build outputs, native binaries, downloaded SDKs, logs, screenshots,
and the exploratory size-measurement copy stay out of Git.

The retained runtime still includes its build machinery, platform backends,
headers, and tests. Arbitrarily deleting those to reduce line count makes an
upstream refresh harder. Vendoring can later be replaced by a pinned dependency
once the local patches are upstreamed and distribution is reproducible.

### Editing the runtime

Edit `vendor/react-native-gpui`, then run `npm run gpui:install` before rebuilding.
npm copies local packages rather than symlinking them; the install command
refreshes those copies even when their versions have not changed.

There are two local renderer changes:

- `node_view.rs`: a `pointerEvents="box-none"` view must not install its own hit
  area. Before the patch, Paseo's empty portal overlay intercepted sidebar clicks.
- `StatusBar.desktop.js`: desktop windows do not have the mobile OS status bar.

GPUI remains a pinned Cargo git dependency. Upstream tooling downloads Hermes
and React Native prebuilt libraries. The snapshot is not an offline or fully
source-built distribution, and release packaging has not been verified.

## Working slice and limits

Verified on Linux x86_64: all 24 app routes in the bundle, connection to the dev
daemon, the real project/workspace sidebar, opening an existing workspace,
existing message rendering, and native composer typing/deletion. The native
regression test restores the draft and does not send a message. Rust tests cover
SHA-256/random-byte bounds and real SQLite parameter binding/transaction rollback.

The following are not feature-parity claims:

| Area                               | Current state                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Styling                            | Adapter evaluates existing Unistyles theme/style factories and breakpoints. No Nitro shadow-tree integration. Full theme/resize behavior needs QA.            |
| Storage/crypto/localization        | Native filesystem + SQLite + SHA-256 + OS randomness. Intl ships English locale data and IANA time zones. The Rust service contains Linux-specific OS access. |
| Clipboard/files                    | Text clipboard, native file dialogs, PNG/JPEG picking, and download/export adapters exist. End-to-end dialog/transfer coverage is still missing.              |
| Voice/camera/push/power inhibition | Unavailable. Requests either report the missing capability or use the app's existing unavailable-capability implementation.                                   |
| Image conversion/image clipboard   | Unavailable. The picker accepts PNG/JPEG without conversion.                                                                                                  |
| Mermaid/HTML/document previews     | Mermaid and HTML show source. Document previews report unavailable. No embedded browser backend.                                                              |
| Terminals                          | The mobile view expects an Expo `PaseoTerminal` component. No GPUI implementation yet.                                                                        |
| Diffs                              | The mobile surface uses React Native Skia. No GPUI drawing backend yet.                                                                                       |
| Plugins                            | The existing loader evaluates JS and injects host React/RN. No end-to-end plugin verification on GPUI yet.                                                    |
| Other platforms                    | The upstream runtime targets macOS/Windows too; this Paseo integration has only been exercised on Linux.                                                      |

The initial stripped development executable was about 68 MiB, with about 10 MiB
of Hermes/JSI libraries and a 21 MiB JS bundle, approximately 100 MiB uncompressed.
That measurement excludes the daemon, is not an optimized release installer, and
does not establish memory usage or a size advantage over another renderer.

## Experiments to pick up

Each experiment should preserve the real app and demonstrate a user workflow.

1. **Native terminal.** Implement a GPUI component for the existing
   [`PaseoTerminalView`](../modules/paseo-terminal/index.tsx) frame contract.
   Keep the JS headless xterm emulator, transport, and frame generation initially.
   Verify resize/replay, keyboard/IME/paste, scrollback/selection, and the existing
   Unicode corpus. [Terminal rendering](../../../docs/terminal-rendering.md)
   explains why shaping must preserve xterm's cell columns.
2. **Diff surface.** Keep `src/git/diff-document`'s model and review actions;
   add GPUI text measurement and painting instead of the Skia surface. Test
   unified/split views, wrapping, scrolling, selection, and inline reviews on
   large real diffs. The [C++ layout experiment](../modules/paseo-diff-prototype/README.md)
   is a separate candidate for shared geometry; it is not a finished renderer.
3. **Plugins.** Load a small plugin into an isolated daemon, open its real screen
   or workspace panel, call a plugin RPC, and reload it. Verify subscriptions and
   cleanup. Track unsupported services explicitly instead of adding fake APIs.
4. **Native services and styling.** Exercise dialogs, downloads, clipboard,
   persistence/restart, theme switching, resizing, and focus. Replace the narrow
   adapters with complete implementations only where the app needs them.
5. **Portability and packaging.** Build on clean Linux, then macOS/Windows. Replace
   Linux-only randomness/timezone access, check font/shaping and IME behavior, and
   verify relocatable libraries/assets. Measure a release build and a controlled
   workflow before claiming a performance or size improvement.
6. **Bundled daemon, independently.** First run the unchanged daemon under Bun
   in isolation. Verify PTY/native dependencies, terminal-worker subprocesses,
   provider launches, and dynamic plugins. Then compare standalone/AOT packaging
   and size. This branch neither ports the daemon nor embeds it in the UI process.

A Rust/GPUI terminal or diff painter can share desktop implementation across the
upstream renderer's supported OSes. Reusing it on mobile still requires mobile
bindings and graphics integration; choosing Rust or C++ alone does not provide that.

## Verification

Run the normal checks from the root. GPUI adapters are excluded from the mobile
TypeScript project; its typecheck alone does not validate this target.

```sh
npm run typecheck
npm run lint
npm run format:check
```

For the native UI regression, use a daemon with an existing workspace and build
with the driver. Run the native app on an isolated display when testing on a
machine in use:

```sh
EXPO_PUBLIC_LOCAL_DAEMON=localhost:6768 npm run build:gpui -- --features test-driver,visual-capture
RN_GPUI_TEST_DRIVER=1 RN_GPUI_TEST_DRIVER_TOKEN=local-test \
RN_GPUI_DEV_MODE=0 RN_GPUI_BUNDLE="$PWD/.artifacts/gpui/paseo.bundle" \
RN_GPUI_ASSETS_DIR="$PWD/.artifacts/gpui/assets/assets" \
xvfb-run -a -s '-screen 0 2560x1600x24' \
packages/app/gpui/desktop/target/debug/react-native-gpui-paseo-gpui
```

Use the printed `RN_GPUI_TEST_DRIVER_PORT` in another shell:

```sh
PASEO_GPUI_TEST_URL=ws://127.0.0.1:PORT PASEO_GPUI_TEST_TOKEN=local-test \
npx vitest run packages/app/gpui/native.test.ts --bail=1
```

Without a driver URL the test is skipped. Put diagnostic logs/captures in
`.artifacts/gpui/`; do not commit them or publish private workspace contents as QA.
