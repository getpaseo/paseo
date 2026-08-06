# Handoff — plugin system PR

## Goal

Ship a plugin system + marketplace for Paseo on branch `feat/plugin-system` (cut from `origin/main`, no pre-existing PR covers this). Stakeholder ask: VS Code-style extensions so things like the CSV/HTML file previews and a "sidebar pet" become plugins instead of core PRs. Requirements from the user: review loop first, **only open the PR once reviewer agents approve**, do everything needed for CONTRIBUTING.md, then babysit the PR until every comment is resolved.

## Done and verified

4 commits on `feat/plugin-system`, ~5.5k lines, 72 files:

- `c4022e844` protocol — manifest + RPC schemas, wired into inbound/outbound unions and `server_info.features.plugins`
- `be22d767f` client — 6 `pluginsX` methods on `DaemonClient`
- `34aabbb84` server + CLI + docs + example plugin
- `40153460e` app — sandbox, file preview, sidebar panel, Settings → Plugins

Green at repo root: `npm run typecheck` exit 0, `npm run lint` 0 warnings/0 errors, `npm run format:check` clean.
Agent-reported test runs: server plugin suite PASS (50), app unit PASS (61), app browser PASS (4), protocol PASS (18), cli PASS (7). Per CLAUDE.md do NOT re-run these.

Replaced the server agent's 162-line hand-rolled semver with the real `semver` package (declared in `packages/server/package.json`, `includePrerelease: true` so beta daemons don't mark every plugin unavailable). Its 19 tests still pass.

## Review round 1 — ALL THREE REVIEWERS SAID DO NOT SHIP

No approval. PR stays closed. Two criticals were found **independently by two reviewers**, so treat them as certain:

- **C1 native exfiltration.** `sandbox.tsx` sets `originWhitelist={["about:blank"]}`. react-native-webview checks the whitelist _first_ and hands non-matching URLs to `Linking.openURL` — opens the user's real browser with the payload in the query string, and `onShouldStartLoadWithRequest` is never called. Fix is counterintuitive: `originWhitelist={["*"]}` so everything reaches the callback, then deny by URL there.
- **C2 CSP defeated.** `wrapPluginHtml` regex-matches `<head>` in attacker-controlled HTML; `<!-- <head> -->` puts the meta in a comment and the doc ships with no CSP → full `fetch`/`sendBeacon` exfil on every platform. Fix: always emit our own shell, never parse guest HTML.

Both falsify the `docs/plugins.md` Trust claim "It cannot exfiltrate any of that". **That doc line must not ship as written.**

Other confirmed: `open-file` is an arbitrary-file-read primitive (C3); install() non-atomic + no per-id lock (destroys the working copy on a failed reinstall); a missing manifest silently erases installed.json state; uncapped download OOMs the daemon; one bad registry entry bricks browse for every deployed daemon; `list()` writes to disk on every read; CLI has no `features.plugins` gate.

Full reviewer text: `/tmp/claude-1000/.../tasks/{a6f4f4bbcde8ccb2d,a9d73972fd9495596,a6daef1da43e2142b}.output`

## Fix round 1 — DONE, committed as `289d48125`

All four fix agents' work landed (sandbox security, server store/registry, session+CLI, app UI). 46 files, +1955/-459. Docs (`docs/plugins.md`, `SECURITY.md`) reconciled by me — the false "cannot exfiltrate" claim is gone, replaced with the three controls that have to hold.

Gate re-verified by me personally after the agents: `npm run typecheck` exit 0, `npm run lint` 0 errors, `npm run format:check` clean, app plugin tests 39 pass + 4 browser pass, server plugin 50 pass, protocol 21 pass, CLI 10 pass.

The UI agent **died on a session quota limit** mid-task and left broken edits. I finished them myself:

- missing `useHostFeature` import in `queries.ts` (typecheck was red)
- it had introduced **two `useUnistyles()` calls**, which `docs/unistyles.md` bans outright with no carveout. Replaced with `usePluginThemeTokens()` in `plugins/theme.ts`, built on RN's reactive `useColorScheme()` plus a static theme import (sanctioned alternative 2). Works because unistyles is configured `adaptiveThemes: true` and nothing calls `setTheme`.
- `FilePane` complexity over the limit → extracted `useFilePreviewRenderer`
- `type` → `interface` in `model.test.ts`

**Quota limit resets 11:10pm America/Sao_Paulo.** Per DELEGATION.md's circuit-breaker, do NOT re-spawn agents before then.

## Still to do

1. **Re-review** the fixes. Round 1 proved a green gate means nothing for this feature — two exfil holes shipped past typecheck/lint/tests. The security reviewer must specifically re-check the CSP shell and the native navigation gate.
2. **QA evidence** — still missing, CONTRIBUTING closes PRs without it. Screenshots of Settings → Plugins, a plugin file preview, the sidebar pet. `docs/qa.md`, `docs/browser-capture-harness.md`. Platform matrix honestly: only Linux/web exercised, native sandbox changes are UNTESTED on a real device.
3. Push, open PR, babysit comments.

Known loose end: `PluginService.install` accepts `{refresh}` but no RPC/CLI flag reaches it.

## Key decisions (do not relitigate)

- **A plugin is a manifest + self-contained HTML files**, served over the existing WebSocket RPC, not over HTTP. Kills the asset-server, auth-ordering, and relay problems in one stroke. Entries are flat `*.html` only.
- **Sandbox:** web/Electron `<iframe sandbox="allow-scripts">` (deliberately no `allow-same-origin`), native `react-native-webview` with navigation locked. Injected CSP denies network.
- **Bridge is tiny on purpose:** `ready`/`init`/`update`/`open-file`/`resize`. Widening it is a product decision.
- **Marketplace = a registry index JSON** (`daemon.plugins.registryUrl`, default `https://plugins.paseo.sh/index.json` — does not exist yet, so installs fail until stakeholders host it; say so in the PR). Install verifies SHA-256 per file.
- Codex reviewers were attempted first per the cross-family pairing rule but **both died with HTTP 401** (OpenAI auth unavailable here). Circuit-breaker applied: did not re-spawn. Fell back to Claude reviewers — **disclose this limitation in the PR**.

## Files that matter

- `docs/plugins.md` — the contract; authoritative, agents were told not to edit it
- `packages/protocol/src/plugin/{types,rpc-schemas}.ts` — wire shapes
- `packages/server/src/server/plugin/{store,registry-client,service,version-range}.ts` — install + discovery
- `packages/server/src/server/session/plugin/plugin-session.ts` — the 6 RPC handlers
- `packages/app/src/plugins/{bridge,frame.web,sandbox,sandbox.web,queries}.ts(x)` — sandbox + bridge
- `packages/app/src/components/file-pane-render-mode.ts` — extension → viewer resolution
- `packages/app/src/stores/explorer-tab-memory.ts` — `ExplorerTab` widened to `plugin:${string}`
- `examples/plugins/hello-paseo/` — working example, both contribution kinds
- CONTRIBUTING.md / SECURITY.md / CLAUDE.md / docs/{architecture,glossary,providers}.md — already updated

## Traps

- Pre-commit runs a whole-repo typecheck; commit with `--no-verify` only while other agents have files in flight, and always run the full gate before pushing.
- Rebuild with `npm run build:client` / `build:server` before believing a cross-package type error.
- Never run the full test suite locally.
