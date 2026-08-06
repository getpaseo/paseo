# Handoff — plugin system PR

## Goal

Ship a plugin system + marketplace for Paseo on branch `feat/plugin-system` (cut from `origin/main`, no pre-existing PR covers this). Stakeholder ask: VS Code-style extensions so things like the CSV/HTML file previews and a "sidebar pet" become plugins instead of core PRs. User's requirements: review loop first, **only open the PR once reviewer agents approve**, do everything needed for CONTRIBUTING.md, then babysit the PR until every comment is resolved.

## Branch state

6 commits, 98 files, +8151/-244. Nothing pushed. No PR open.

```
53cac5843 Close the plugin frame self-navigation hole and fix the theme regression   <- round 2 fixes
289d48125 Fix plugin sandbox escapes and store atomicity from review                 <- round 1 fixes
40153460e feat(app): render plugin file previews and sidebar panels in a sandbox
34aabbb84 feat(server,cli): plugin store, registry install, RPCs, and CLI
be22d767f feat(client): add plugin RPC methods to the daemon client
c4022e844 feat(protocol): add plugin manifest and plugin RPC schemas
```

Gate green at HEAD: `npm run typecheck` clean, `npm run lint` 0/0, `npm run format:check` clean. App plugin suites 54 unit + 5 browser pass; server/desktop suites reported green by the agent that wrote them. Per CLAUDE.md do NOT re-run these.

## Review status

Two rounds, both rejected. **Three exfiltration holes have now shipped past a fully green typecheck/lint/test gate.** Do not treat the gate as evidence for this feature.

- Round 1 (2 holes): regex-placed CSP defeated by `<!-- <head> -->` in guest HTML; `originWhitelist: ["about:blank"]` on native, which react-native-webview consults _before_ the navigation callback, handing the URL to `Linking.openURL` and the user's real browser.
- Round 2 (1 hole, survived the round-1 fixes): the plugin iframe navigating **itself**. The guest CSP cannot stop that — `navigate-to` was dropped from the spec and `default-src` does not cover a document's own navigation. Fixed with `frame-src 'none'` on the **host** document (a child frame's navigation is checked against the parent's policy; `about:srcdoc` is exempt so the plugin still renders). Reproduced and closed in real Electron with a local HTTP server counting hits.

Round 3 reviewers are running as of this writing: security (fable, tasked with finding a fourth hole and told to prove it with a probe) and correctness (opus, tasked with verifying the round-2 fixes rather than trusting them).

## What round 2 fixed, in 53cac5843

- Host-document `frame-src 'none'` in `packages/server/src/server/web-ui.ts` (header) and `packages/app/public/index.html` (meta — this is what Electron's `paseo://` handler and the Expo dev server serve). Plus `setupSubframeNavigationPrevention()` in the desktop window manager on `will-frame-navigate`.
- `packages/app/src/plugins/theme.ts` no longer derives tokens from `useColorScheme()` + a static theme import. That was a real regression: the app theme is user-selectable independently of the OS scheme (`app/_layout.tsx` calls `UnistylesRuntime.setTheme`), so OS-dark + app-light gave a fully inverted palette, and font patches applied via `UnistylesRuntime.updateTheme` never arrived. Both sandboxes now take `themeTokens` as a prop via `withUnistyles`. `useUnistyles()` stays banned (docs/unistyles.md).
- `open-file` round trip. The host handed plugins an absolute `context.path` and then rejected it on the way back, so the documented example plugin's line-click silently did nothing. `toPluginRelativePath`/`fromPluginRelativePath` in bridge.ts, `workspaceRoot` threaded through the file pane chain.
- Install rollback no longer `rm`s the trash dir when the _restore_ rename failed (that destroyed the last copy). `PluginEntryUnavailableError` allowlisted in `clientMessage()`.
- Plugin-authored preview titles clamped at 24 chars where they enter the render model.
- Reverted a repo-wide `allowImportingTsExtensions` in `packages/app/tsconfig.json` that an agent added to work around a test import; moved `isPluginDocumentUrl` into `sandbox-url.ts` instead.
- `docs/plugins.md` and `SECURITY.md` said three mechanisms had to hold. It is four. Corrected, and both now say three of the four were found broken across two rounds.

## Still to do

1. Round 3 verdicts. **The PR does not open until reviewers approve** — that is the user's explicit instruction, not a guideline.
2. QA evidence. CONTRIBUTING closes PRs without it. Screenshots of Settings → Plugins, a plugin file preview, the sidebar pet. `docs/qa.md`, `docs/browser-capture-harness.md`. `.qa/` is gitignored. Platform matrix must be honest: only Linux/web exercised; **native sandbox changes are UNTESTED on a real device**.
3. Push, open PR, babysit comments.

## Must be disclosed in the PR

- **Codex reviewers are unavailable here** — both attempts died with HTTP 401 from api.openai.com. The cross-family pairing rule in DELEGATION.md could not be satisfied; every review is Claude-on-Claude.
- `https://plugins.paseo.sh/index.json` (the default `daemon.plugins.registryUrl`) **does not exist yet**, so registry installs fail until stakeholders host it. Local and by-hand installs work.
- iOS and Android are untested on real devices.
- Known loose end: `PluginService.install` accepts `{refresh}` but no RPC or CLI flag reaches it.

## Key decisions (do not relitigate)

- **A plugin is a manifest + self-contained HTML files**, served over the existing WebSocket RPC, not over HTTP. Kills the asset-server, auth-ordering, and relay problems in one stroke. Entries are flat `*.html` only.
- **Sandbox:** web/Electron `<iframe sandbox="allow-scripts">` (deliberately no `allow-same-origin`), native `react-native-webview` with navigation locked. Guest CSP denies network; host CSP denies the frame navigating out.
- **Bridge is tiny on purpose:** `ready`/`init`/`update`/`open-file`. (`resize` was removed — nothing consumed it.) Widening it is a product decision.
- **Marketplace = a registry index JSON.** Install verifies SHA-256 per file.

## Traps

- Pre-commit runs a whole-repo typecheck; `--no-verify` only while agents have files in flight, and always run the full gate before pushing.
- Rebuild with `npm run build:client` / `build:server` before believing a cross-package type error.
- Never run the full test suite locally.
- `rg` returned false "0 matches" in this checkout at least once and caused a wrong conclusion. Prefer `grep`, and verify negative results before acting on them.
