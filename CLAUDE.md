# CLAUDE.md

Paseo is a mobile app for monitoring and controlling your local AI coding agents from anywhere. Your dev environment, in your pocket. Connects directly to your actual development environment — your code stays on your machine.

**Supported agents:** Claude Code, Codex, GitHub Copilot, OpenCode, and Pi.

## Repository map

This is an npm workspace monorepo:

- `packages/server` — Daemon: agent lifecycle, WebSocket API, MCP server
- `packages/app` — Mobile + web client (Expo)
- `packages/cli` — Docker-style CLI (`paseo run/ls/logs/wait`)
- `packages/relay` — E2E encrypted relay for remote access
- `packages/desktop` — Electron desktop wrapper
- `packages/website` — Marketing site (paseo.sh)

## Docs

`docs/` is the source of truth for system-level and process-level knowledge. **"The docs", "check the docs", or "check the X docs" always mean this directory — not the web.** Look here before fetching anything online; the docs capture gotchas and conventions you cannot derive from the code or external sources.

At the start of non-trivial work, list `docs/` and skim anything relevant to the task.

| Doc                                                                | What's in it                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| [docs/product.md](docs/product.md)                                 | What Paseo is, who it's for, where it's going                                                                                  |
| [docs/architecture.md](docs/architecture.md)                       | System design, package layering, WebSocket protocol, agent lifecycle, data flow                                                |
| [docs/agent-lifecycle.md](docs/agent-lifecycle.md)                 | Agent states, parent/child relationships, archive semantics, tabs vs archive, subagents track                                  |
| [docs/data-model.md](docs/data-model.md)                           | File-based JSON persistence, Zod schemas, atomic writes, no migrations                                                         |
| [docs/glossary.md](docs/glossary.md)                               | Authoritative terminology — UI label wins, no synonyms                                                                         |
| [docs/coding-standards.md](docs/coding-standards.md)               | Type hygiene, error handling, state design, React patterns, file organization                                                  |
| [docs/design.md](docs/design.md)                                   | Design system — tokens, buttons, hierarchy, density, alignment rails, states, what's forbidden                                 |
| [docs/forms.md](docs/forms.md)                                     | Form architecture — non-React form model, form kit, load-state gating; the schedule form is the golden example                 |
| [docs/hover.md](docs/hover.md)                                     | Hover — the canonical pattern (plain View + onPointerEnter/Leave, separate inner Pressable) and the three ways agents break it |
| [docs/unistyles.md](docs/unistyles.md)                             | Unistyles gotchas — `useUnistyles()` is forbidden, alternatives in order                                                       |
| [docs/floating-panels.md](docs/floating-panels.md)                 | Anchored popovers — Portal/Modal escape for Android, lifecycle gates, keyboard-shared-value, status-bar offset, the flash      |
| [docs/expo-router.md](docs/expo-router.md)                         | Expo Router route ownership, startup restore, and native blank-screen gotchas                                                  |
| [docs/file-icons.md](docs/file-icons.md)                           | Material icon theme integration for the file explorer                                                                          |
| [docs/providers.md](docs/providers.md)                             | Adding a new agent provider end-to-end                                                                                         |
| [docs/forge-providers.md](docs/forge-providers.md)                 | Adding a git forge: registry/manifest, drop-in checklist, self-host/GHES, the two facts tiers                                  |
| [docs/custom-providers.md](docs/custom-providers.md)               | Custom provider config: Z.AI, Alibaba/Qwen, ACP agents, profiles, custom binaries                                              |
| [docs/service-proxy.md](docs/service-proxy.md)                     | Service proxy: exposing workspace scripts at public URLs, DNS setup, reverse proxy config                                      |
| [docs/development.md](docs/development.md)                         | Dev server, build sync gotchas, CLI reference, agent state, Playwright MCP                                                     |
| [docs/rpc-namespacing.md](docs/rpc-namespacing.md)                 | WebSocket RPC naming convention — dotted namespaces and `.request`/`.response` pairs                                           |
| [docs/protocol-compatibility.md](docs/protocol-compatibility.md)   | Why app/daemon versions drift, protocol vs feature contract, capability gating, COMPAT tagging                                 |
| [docs/protocol-validation.md](docs/protocol-validation.md)         | zod-aot generated inbound WebSocket validation, patched compiler regressions, schema-purity rules                              |
| [docs/terminal-performance.md](docs/terminal-performance.md)       | Terminal latency pipeline, coalescing/backpressure invariants, benchmark + perf spec usage                                     |
| [docs/testing.md](docs/testing.md)                                 | TDD workflow, determinism, real dependencies over mocks, test organization                                                     |
| [docs/qa.md](docs/qa.md)                                           | QA evidence bar for pull requests — platform matrix, version drift, performance, UI proof                                      |
| [docs/mobile-testing.md](docs/mobile-testing.md)                   | Maestro and mobile test workflows                                                                                              |
| [docs/mobile-panels.md](docs/mobile-panels.md)                     | Compact left/center/right panel ownership, worklet motion, gesture revisions, and Fabric constraints                           |
| [docs/ad-hoc-daemon-testing.md](docs/ad-hoc-daemon-testing.md)     | Isolated in-process daemon test harness                                                                                        |
| [docs/browser-capture-harness.md](docs/browser-capture-harness.md) | Real-Electron browser screenshot harness and compositor-surface gotcha                                                         |
| [docs/workflows.md](docs/workflows.md)                             | Native JSON workflows: ownership, routing, storage, recovery, authorization, and surfaces                                      |
| [docs/android.md](docs/android.md)                                 | App variants, local/cloud builds, EAS workflows                                                                                |
| [docs/docker.md](docs/docker.md)                                   | Running the daemon and bundled web UI in Docker, volumes, agent images, security                                               |
| [docs/release.md](docs/release.md)                                 | Release playbook, draft releases, completion checklist                                                                         |
| [docs/terminal-activity.md](docs/terminal-activity.md)             | Terminal activity indicators — source-agnostic tracker, agent hook reporting, adding a new hook provider                       |
| [SECURITY.md](SECURITY.md)                                         | Relay threat model, E2E encryption, DNS rebinding, agent auth                                                                  |

### Writing docs

- **Integrate, don't append.** Find the doc that owns the subject and rewrite the part that is now wrong. The standard failure is finishing a task and adding a paragraph to the bottom of the closest-looking doc; ten tasks later the doc is a pile of paragraphs in discovery order. `docs/custom-providers.md` is what that looks like.
- **Don't document logic.** Prose that restates code drifts from the code and loses. Write down what the code can't tell you: why something is shaped the way it is, the gotcha that cost an afternoon, conventions nothing enforces, constraints that span packages or versions. If a reader could get it in two minutes by opening the file, cut it.
- **One fact, one doc.** Every other mention is a link. If you are about to write the same paragraph in two docs, one of them is a link.
- **Respect the layers.** `CONTRIBUTING.md` and this file name things and link out. Activity docs like `docs/qa.md` and `docs/testing.md` set the bar for a kind of work. Subject docs like `docs/unistyles.md` own one thing completely. A layer never re-explains the one below it.
- **One subject per doc.** If the subject doesn't fit in a sentence, split the doc. A section per provider, vendor, or platform is a table plus one worked example.
- **Delete.** Obsolete sections go. Prefer a `packages/app/src/thing.ts:120` reference over a pasted block.
- **New doc?** Add a row to the table above and link it from the docs that should send readers there.
- Code-level facts belong in comments next to the code, not here.

### Doc voice

Plain and short. Second person. State the rule, then the reason when the reason isn't obvious. Match the doc you're editing.

Do not:

- Write a sentence to land a point. "It's not X, it's Y", "That's not a Z, that's a W", and every other setup-and-punchline shape.
- Add a clause that only asserts importance: "and that matters", "which is what keeps it working", "this is critical".
- Use "honest", "robust", "seamless", "powerful", "simply", "just", "delightful".
- Restate something you already said, in different words, for emphasis.
- Hedge with "generally", "typically", or "you may want to" when the answer is "do this".
- Clear your throat: "It's worth noting that", "In order to", "This section covers".

## Quick start

```bash
npm run dev                          # Start the dev daemon
npm run dev:app                      # Start Expo against the dev daemon
npm run dev:desktop                  # Start Electron desktop dev
npm run cli -- ls -a -g              # List all agents
npm run cli -- daemon status         # Check daemon status
npm run typecheck                    # Always run after changes
npm run lint                         # Always run after changes
npm run format                       # Auto-format with Biome
npm run format:check                 # Check formatting without writing
```

Repo dev commands use checkout-local state by default. In this checkout, `PASEO_HOME` resolves to `.dev/paseo-home`, and `npm run cli -- ...` targets that same dev home automatically. The packaged desktop app and production-style daemon keep using `~/.paseo` on port `6767`.

See [docs/development.md](docs/development.md) for full setup, build sync requirements, and debugging.

## Critical rules

- **NEVER restart the main Paseo daemon on port 6767 without permission** — it manages all running agents. If you're an agent, restarting it kills your own process.
- **NEVER assume a timeout means the service needs restarting** — timeouts can be transient.
- **NEVER add auth checks to tests** — agent providers handle their own auth.
- **Before changing app routes, startup routing, remembered workspace restore, or active workspace selection, read [docs/expo-router.md](docs/expo-router.md).**
- **NEVER run the full test suite locally.** The test suites are heavy and will freeze the machine, especially if multiple agents run them in parallel. Rules:
  - Run only the specific test file you changed: `npx vitest run <file> --bail=1`
  - Never run `npm run test` for an entire workspace unless explicitly asked.
  - If you must run a broad suite, pipe output to a file and read it afterward: `npx vitest run <file> --bail=1 > /tmp/test-output.txt 2>&1` then read the file.
  - Never re-run a test suite that another agent already ran and reported green — trust the result.
  - For full suite verification, push to CI and check GitHub Actions instead.
- **Always run typecheck and lint after every change.**
- **Build workspace packages before diagnosing cross-package type errors.** This repo consumes generated declarations across workspaces. If typecheck fails in a package that depends on another workspace, rebuild the owning stack first so `dist` declarations are current:
  - `npm run build:client` — rebuild protocol and client declarations.
  - `npm run build:server` — rebuild highlight, relay, protocol, client, server, and CLI when server/CLI types may be stale.
  - Do not patch inferred callback parameters or add local duplicate types just to silence stale declaration errors.
- **Run `npm run format` before committing.** This repo uses Biome for formatting. Do not manually fix formatting — let the formatter handle it.
- **Always use npm scripts for linting and formatting.** Do not run tools directly with `npx eslint`, `npx oxfmt`, `npx oxlint`, or package-local binaries. For targeted checks, pass file paths through the npm script:
  - `npm run lint -- packages/app/src/components/message.tsx`
  - `npm run format:files -- CLAUDE.md packages/app/src/components/message.tsx`
- **The protocol stays backward-compatible. Features don't have to.** Read [docs/protocol-compatibility.md](docs/protocol-compatibility.md) before touching `packages/protocol`. The short version:
  - **Protocol contract (always):** an old client parses messages from a new daemon, and a new daemon parses messages from an old client. New fields are optional; never narrow, never remove, never require. Wire schemas stay pure — no `.transform()`, `.catch()`, or `.preprocess()`.
  - **Feature contract (per-feature):** gate the capability once on `server_info.features.*`, then run the feature or tell the user to update the host. No fallback paths, no defensive branches.
  - **Every shim is tagged.** `// COMPAT(name): added in vX, remove after <date>` at the site that has to be deleted. `rg "COMPAT\("` is the cleanup backlog; untagged back-compat is permanent by accident.
  - **New RPCs use dotted namespaces with direction suffixes.** Follow [docs/rpc-namespacing.md](docs/rpc-namespacing.md): `domain.provider.operation.request` pairs with `domain.provider.operation.response`. Existing flat RPC names will migrate over time; don't add new ones.

## Platform gating

The app runs on iOS, Android, web (browser), and web (Electron desktop). Code is cross-platform by default. Gate only when you must. Import gates from `@/constants/platform`.

### The four gates

| Gate                       | Type      | When to use                                                                                                                 |
| -------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `isWeb`                    | constant  | DOM APIs — `document`, `window`, `<div>`, `addEventListener`, `ResizeObserver`. This is the **exception**, not the default. |
| `isNative`                 | constant  | Native-only APIs — Haptics, `StatusBar.currentHeight`, push tokens, camera/scanner, `expo-av`.                              |
| `getIsElectron()`          | cached fn | Desktop wrapper features — file dialogs, titlebar drag region, daemon management, app updates, dock badges.                 |
| `useIsCompactFormFactor()` | hook      | Layout decisions — sidebar overlay vs pinned, modal vs full screen, single-panel vs split. From `@/constants/layout`.       |

### Decision matrix

| I need to...                                                   | Use                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Access DOM (`document`, `window`, `<div>`, `addEventListener`) | `if (isWeb)`                                                              |
| Use a native-only API (Haptics, push tokens, camera)           | `if (isNative)`                                                           |
| Use an Electron bridge (file dialog, titlebar, updates)        | `if (getIsElectron())`                                                    |
| Switch layout between phone and tablet/desktop                 | `useIsCompactFormFactor()`                                                |
| Show something on hover, always-visible on native              | `isHovered \|\| isNative \|\| isCompact` (hover only works on web)        |
| Gate to iOS or Android specifically                            | `Platform.OS === "ios"` / `Platform.OS === "android"` (rare, keep inline) |

### Rules

- **Default is cross-platform.** Don't gate unless you have a specific reason.
- **Prefer Metro file extensions over `if` statements.** When a module has fundamentally different implementations per platform, use `.web.ts` / `.native.ts` file extensions instead of runtime `if (isWeb)` branches. Metro resolves the correct file at build time — the unused platform code is never bundled. Reserve `if (isWeb)` for small, inline checks (a single line or a few props). If you find yourself writing a large `if (isWeb) { ... } else { ... }` block, split into separate files instead.
  ```
  hooks/
    use-audio-recorder.web.ts    ← uses Web Audio API
    use-audio-recorder.native.ts ← uses expo-audio
  ```
  Import as `@/hooks/use-audio-recorder` — Metro picks the right file automatically.
- **Use `.electron.ts` / `.electron.tsx` for Electron-only web modules.** Electron is still the Metro `web` platform, but desktop dev/build sets `PASEO_WEB_PLATFORM=electron`, so Metro first looks for `.electron.*` files and falls back to normal `.web.*` files. Use this when the implementation depends on Electron-only behavior such as `webviewTag`, desktop preload APIs, or the Electron bridge. Keep plain browser web in `.web.*`, and keep native fallbacks in the base file or `.native.*`.
  ```
  components/
    browser-pane.electron.tsx ← Electron <webview> implementation
    browser-pane.web.tsx      ← plain web fallback
    browser-pane.tsx          ← native fallback
  ```
  Import as `@/components/browser-pane` — Electron desktop gets the `.electron.tsx` file, browser web gets `.web.tsx`, and native gets the native/base implementation.
- **NEVER use raw DOM APIs without `isWeb` guard.** DOM APIs crash native. Casting a RN ref to `HTMLElement` is a red flag — ensure the block is web-only.
- **NEVER use `onPointerEnter`/`onPointerLeave`.** They don't fire on native iOS.
- **Hover only works on web.** React Native's `onHoverIn`/`onHoverOut` on `Pressable` does NOT fire on native iOS/iPad — the underlying W3C pointer events are behind disabled experimental flags. For hover-to-show UI (kebab menus, action buttons), use `isHovered || isNative || isCompact` so the controls are always visible on native and hover-to-show on web.
- **Don't use Platform.OS as a proxy for layout capabilities.** Use breakpoints for layout decisions, not platform checks.
- **Import `isWeb`/`isNative` from `@/constants/platform`.** Never write `const isWeb = Platform.OS === "web"` locally.

## Debugging

Find the complete daemon logs and traces in the $PASEO_HOME/daemon.log
