# Handoff — plugin system PR

## Goal

Ship a plugin system + marketplace for Paseo on branch `gallant-elephant` (cut from `origin/main`, no pre-existing PR covers this). Stakeholder ask: VS Code-style extensions so things like the CSV/HTML file previews and a "sidebar pet" become plugins instead of core PRs. User's requirements: review loop first, **only open the PR once reviewer agents approve**, do everything needed for CONTRIBUTING.md, then babysit the PR until every comment is resolved.

## Branch state

Nothing pushed. No PR open. Branch is `gallant-elephant`, cut from `origin/main`.

```
58b5e12de Capture Object.create in the plugin shell, and verify the root it forced open <- round 10 fix
c9a950658 Stop the attachShadow wrapper swallowing what the platform would reject     <- round 9 correctness
faeecf01c Give the observer nothing the plugin can reach through a prototype        <- round 9 security
fb954accd Capture the observer's own method, and fix the script-type list           <- round 8 fixes
68e6bb13d Sanitise plugin markup before it is connected, and pin the shell's contract  <- round 7 fixes
57ce09192 Stop enumerating the doors to a fresh plugin realm                          <- round 6 fixes
d2fd1221b Update the plugin PR handoff for round 5
cb096243a Give native the same sandboxed frame, and harden the frame remover        <- round 5 fixes
7732b9ade Update the plugin PR handoff for rounds 3 and 4
b6e1e4432 Deny the plugin child browsing contexts, and fix four review findings      <- round 4 fixes
ea0af1aac Delete WebRTC from the plugin realm, which no CSP directive can deny       <- round 3 fix
53cac5843 Close the plugin frame self-navigation hole and fix the theme regression   <- round 2 fixes
289d48125 Fix plugin sandbox escapes and store atomicity from review                 <- round 1 fixes
40153460e feat(app): render plugin file previews and sidebar panels in a sandbox
34aabbb84 feat(server,cli): plugin store, registry install, RPCs, and CLI
be22d767f feat(client): add plugin RPC methods to the daemon client
c4022e844 feat(protocol): add plugin manifest and plugin RPC schemas
```

Gate green at HEAD: `npm run typecheck` clean, `npm run lint` 0/0, `npm run format` clean. App plugin suites 40 unit + 23 browser pass; server/desktop suites reported green by the agent that wrote them. Per CLAUDE.md do NOT re-run these.

## Review status

Eleven rounds, all rejected so far. **Eleven exfiltration holes and eight silent regressions have now shipped past a fully green typecheck/lint/test gate** (round 11's `<webview>` finding is a twelfth gap, but it was measured non-exploitable — see below). Do not treat the gate as evidence for this feature.

- Round 1 (2 holes): regex-placed CSP defeated by `<!-- <head> -->` in guest HTML; `originWhitelist: ["about:blank"]` on native, which react-native-webview consults _before_ the navigation callback, handing the URL to `Linking.openURL` and the user's real browser.
- Round 2 (1 hole, survived the round-1 fixes): the plugin iframe navigating **itself**. The guest CSP cannot stop that — `navigate-to` was dropped from the spec and `default-src` does not cover a document's own navigation. Fixed with `frame-src 'none'` on the **host** document (a child frame's navigation is checked against the parent's policy; `about:srcdoc` is exempt so the plugin still renders). Reproduced and closed in real Electron with a local HTTP server counting hits.

- Round 3 (1 hole): **WebRTC.** `default-src 'none'` does not cover `RTCPeerConnection` and no directive does — Chromium logs `webrtc` as an unrecognised directive and sends the packets anyway. The reviewer stood up a real TURN server and confirmed previewed file content arrived verbatim in the STUN Allocate packets. Fixed in `ea0af1aac` by deleting the constructors from the realm in the document shell.
- Round 4 (1 hole, and it was the round-3 fix being incomplete): **the deletion only covers the realm it ran in.** A plugin that appends an `<iframe srcdoc>` gets a fresh realm with `RTCPeerConnection` intact, and there is no way to inject into it — `about:srcdoc` is exempt from `frame-src`, and without `allow-same-origin` its `contentWindow` is unreachable. The round-3 test _looked_ like it covered this but read `child.contentWindow.RTCPeerConnection` from the parent, which throws cross-origin whether or not the child has WebRTC. Fixed in `b6e1e4432` by denying child browsing contexts outright (a `MutationObserver` in the shell removes any iframe/frame/object/embed as it is inserted, which lands before the child parses). Verified both ways.

- Round 5 (1 hole, plus a design fault): the observer itself. `document.write()` after load implies `document.open()`, which builds a fresh `documentElement` and leaves an observer bound to the old one watching a detached node; and every DOM method the sweep resolved at mutation time was replaceable by plugin script, so `Element.prototype.remove = function(){}` left it firing and doing nothing. The design fault was native: it ran the plugin as the WebView's top document with no `sandbox` attribute anywhere, so a frame the plugin creates _inherits_ the parent's origin and `frames[0].RTCPeerConnection` is readable **synchronously**, in the same task as the insertion — nothing racing a parser can cover that. Fixed in `cb096243a`: observe `document`, capture everything up front and apply with `Reflect.apply`, and load the same sandboxed iframe on native inside a host document that relays postMessage. Verified against the old implementation.

- Round 6 (1 hole + 1 silent regression): a frame hidden in a **shadow root**. A `MutationObserver` on `document` is never notified of mutations inside one and `querySelectorAll` does not cross the boundary, so the sweep was blind; a `closed` root is unreachable from script forever afterwards. Fixed by making it a policy rather than a race — plugin markup is inserted, never parsed as the document (which is what takes `<template shadowrootmode="closed">` away, since only the HTML parser honours it), `document.write`/`writeln`/`setHTMLUnsafe`/`parseHTMLUnsafe` throw, and `attachShadow` is wrapped so every root it hands out is watched. The regression: the native host document carried a hand-written CSP narrower than the guest's, and a `srcdoc` frame inherits its parent's policy as an intersection, so plugin images silently stopped loading. Both shells now share one constant. The reviewer also proposed a Permissions-Policy fix for WebRTC — that is a dead end, WebRTC is not a policy-controlled feature in any browser, and it was not followed.
- Round 7 (1 hole + 3 silent regressions): `<link rel="dns-prefetch">` and `rel="preconnect"` resolve an attacker-chosen hostname without making a request, so no CSP directive is consulted — the WebRTC DNS channel, reopened with a `<link>` and no script. A hint fires when the element is connected, before any observer's microtask, so removal cannot win. Fixed in `68e6bb13d` by sanitising the markup while it is still **detached**: `insertAdjacentHTML` into a `<div>` that is not in the document, strip `link`/`iframe`/`frame`/`object`/`embed` there, connect the subtree as a single `DocumentFragment` afterwards; plus `x-dns-prefetch-control: off` on both shells. The three regressions were all in the round-6 security fix, all behind a green suite: `toScriptString` escaped only `</script` (so `<!--` plus a later `<script` derailed the tokenizer into script-data-double-escaped and the whole shell became one unterminated script), script attributes were dropped on re-creation (`document.currentScript.id`/`dataset` gone, `type="application/json"` data blocks executed), and a `replaceChild` throw aborted the re-run loop. `shell.browser.test.ts` now pins the execution model a plugin author is owed; 6 of its 10 cases were red beforehand.

**A residual is now documented rather than closed:** a plugin _script_ can still append `<link rel="preconnect">` and cause one DNS lookup plus TCP/TLS connect to a host of its choosing. CSP has no directive, `x-dns-prefetch-control` is a separate Blink setting that does not cover preconnect, and the hint fires before any interception installable universally — wrapping the dozen DOM insertion APIs would be incomplete by construction, which is the failure mode rounds 4–6 established. Stated in `docs/plugins.md`, `SECURITY.md`, and owed in the PR.

- Rounds 8, 9 and 10 (3 holes + 3 silent regressions) are **one class: late binding.** Round 8, `MutationObserver.prototype.observe` was resolved when the `attachShadow` wrapper called it, so a plugin that no-ops it first gets an unwatched root. Round 9, capturing the callee did nothing for the **argument** — a dictionary is converted with one `Get` per member, so every member the object does not own comes off `Object.prototype`; `attributeFilter` made the conversion throw and `observe` never ran, `clonable` minted a root from `cloneNode` with no `attachShadow` call to wrap. Round 10, the helper that built those null-prototype objects read the **global** `Object.create` when called, and the wrapper calls it on every `attachShadow` — a replacement returning an accessor pair swallows `mode = "open"` and hands back the closed clonable root the wrapper exists to deny.

  Each round found the previous round's fix broken. So the rule is now written into `bridge.ts` above `KILL_CHILD_REALMS` as a three-clause invariant — capture the callee, build the argument bare, resolve nothing global at call time — and the wrapper re-reads `shadowRoot` afterwards and drops the host on a mismatch, so a fourth instance fails closed instead of silently. The round-9 correctness pass also caught the round-8/9 fixes dropping `slotAssignment`/`clonable`/`serializable` and making invalid `attachShadow` calls quietly succeed, and a react-query refresh flag cleared before its await so the retry lost it.

- Round 11 (1 hole + 9 correctness findings). The hole: **Electron's `<webview>`**, in neither denial selector. The desktop renderer runs with `webviewTag: true`, and a guest is a separate `WebContents` with its own session — the plugin CSP does not describe it, the iframe `sandbox` flags are not inherited, the neuter script never runs in it. Not late binding this time; an incomplete enumeration, which is the failure mode the round-6 policy shift was supposed to retire. Fixed in `65f2f3401`, red without it through both the markup and script paths.

  **Measured, and it downgrades the finding.** The reviewer could not confirm that Electron actually attaches a guest from a sandboxed subframe — a Chromium test cannot. Settled directly against `electron@41.2.0` with a real window, an HTTP server counting hits, and `will-attach-webview` logged: a top-frame `<webview>` attaches and fetches from both the markup and script paths; one inside `<iframe sandbox="allow-scripts" srcdoc>` does neither. Not the `sandbox` attribute — an unsandboxed `srcdoc` subframe and one with `nodeIntegrationInSubFrames: true` both fail the same way. The element is main-frame-only in this version, so **this was a gap, not an exploitable hole**, and the PR must say so rather than claiming a twelfth escape. The selector entry stays as depth: that behaviour is an unspecified implementation detail of one Electron version.

  The reviewer also wanted `isPaseoBrowserWebviewAttach` to reject an attach whose initiating frame is not the app's own. **Not done, deliberately:** Electron's `will-attach-webview` carries no `WebFrameMain` (checked against `electron@41.2.0` typings — the event is the bare `Event` type), and the IPC-announcement alternative is async while the attach is synchronous on connection, so it means restructuring the shipped browser pane's mount path for depth behind a control that already holds. Written up in `docs/plugins.md`.

  The correctness findings and their fixes are in `f743d428d`; the two that reached a user were markdown outside the workspace rendering as source, and the whole file pane blocking on `plugins.list`.

**The lesson that keeps repeating:** a denial test has to be driven from where the attacker's code runs. Two rounds in a row, a test written from the host's point of view passed against a live hole. And a fix is not evidence — four consecutive rounds broke the fix in front of them.

## What round 2 fixed, in 53cac5843

- Host-document `frame-src 'none'` in `packages/server/src/server/web-ui.ts` (header) and `packages/app/public/index.html` (meta — this is what Electron's `paseo://` handler and the Expo dev server serve). Plus `setupSubframeNavigationPrevention()` in the desktop window manager on `will-frame-navigate`.
- `packages/app/src/plugins/theme.ts` no longer derives tokens from `useColorScheme()` + a static theme import. That was a real regression: the app theme is user-selectable independently of the OS scheme (`app/_layout.tsx` calls `UnistylesRuntime.setTheme`), so OS-dark + app-light gave a fully inverted palette, and font patches applied via `UnistylesRuntime.updateTheme` never arrived. Both sandboxes now take `themeTokens` as a prop via `withUnistyles`. `useUnistyles()` stays banned (docs/unistyles.md).
- `open-file` round trip. The host handed plugins an absolute `context.path` and then rejected it on the way back, so the documented example plugin's line-click silently did nothing. `toPluginRelativePath`/`fromPluginRelativePath` in bridge.ts, `workspaceRoot` threaded through the file pane chain.
- Install rollback no longer `rm`s the trash dir when the _restore_ rename failed (that destroyed the last copy). `PluginEntryUnavailableError` allowlisted in `clientMessage()`.
- Plugin-authored preview titles clamped at 24 chars where they enter the render model.
- Reverted a repo-wide `allowImportingTsExtensions` in `packages/app/tsconfig.json` that an agent added to work around a test import; moved `isPluginDocumentUrl` into `sandbox-url.ts` instead.
- `docs/plugins.md` and `SECURITY.md` said three mechanisms had to hold. It is four. Corrected, and both now say three of the four were found broken across two rounds.

## Still to do

1. **Round 12, which never ran.** Both agents (security on the frontier tier, correctness on the workhorse) died immediately with `You've hit your session limit · resets 1:30pm America/Sao_Paulo`. Per DELEGATION.md's circuit-breaker they were NOT re-spawned. Re-run them when quota is back — the briefs are in the transcript; the `<webview>` question it was asked to settle is now answered inline (above), and the correctness one targets `f743d428d` and `65f2f3401`, neither of which has been reviewed.
2. **The PR does not open until reviewers approve** — the user's explicit instruction, not a guideline. A REJECT-then-fix is not an approval, and five of eleven rounds found the previous round's fix broken.
3. Push, open PR, babysit comments.

QA evidence is **done**: `.qa/plugins/qa-report.md` plus 4 screenshots (gitignored), e2e 6/6 including a new test that a user-selected theme change (Dark → Zinc, same colour scheme, OS pinned dark) reaches the plugin — proven to fail against the pre-fix code. Platform matrix in the report says plainly that iOS and Android have zero runtime evidence.

CONTRIBUTING.md is **done**, and round 11 fixed the hole in it: it told contributors to publish to the registry without ever saying how, and there is no registry and no submission process. It now says that plainly and links the new `### Self-hosting an index` section in `docs/plugins.md`, which documents the index format and the rules the daemon enforces (https-only file URLs, sha256 + bytes both checked, 1–64 files, 8 MiB, flat `*.html`, a malformed entry loses only its own listing).

## Must be disclosed in the PR

- **Codex reviewers are unavailable here** — both attempts died with HTTP 401 from api.openai.com. The cross-family pairing rule in DELEGATION.md could not be satisfied; every review is Claude-on-Claude.
- `https://plugins.paseo.sh/index.json` (the default `daemon.plugins.registryUrl`) **does not exist yet**, so registry installs fail until stakeholders host it. Local and by-hand installs work.
- iOS and Android are untested on real devices. Round 5 restructured the native path outright — the plugin now renders in a nested sandboxed iframe inside a host document, with a postMessage relay in between — and not one line of that has run on a device or simulator. Everything below the relay is shared with web and is covered in real Chromium; the relay itself is not.
- The frame-removal control is a runtime removal racing a parser, not a policy. It holds in Chromium; that is an empirical result, not a guarantee.
- A plugin cannot embed an `<iframe>`, `<object>` or `<embed>` at all — no YouTube frames, no external SVG. They are removed silently. As of round 7 the same is true of `<link>`, for any `rel`; CSP already denied every resource one could fetch.
- **The `preconnect` residual** described under Review status: a plugin script can still cause one DNS lookup to a host of its choosing. This weakens the "your content stays on your machine" claim for installed plugins specifically, and the honest framing is the VS Code one — an installed plugin is code you trust with the files you open in it.
- **A plugin cannot embed Electron's `<webview>` either.** Say plainly that this was a gap and not a demonstrated escape: measured against `electron@41.2.0`, a subframe cannot attach a guest at all. Include the `will-attach-webview` gate that was deliberately not tightened and why (the event carries no `WebFrameMain`).
- **`attachShadow` always returns an open root.** `mode: "closed"` is accepted and ignored, so `element.shadowRoot` is readable. Everything else about the call is forwarded unchanged.
- `<script type="speculationrules">` is inferred to be blocked by the shell's MIME allowlist but was never demonstrated either way.
- `plugins.paseo.sh` does not resolve (NXDOMAIN), so nobody can exercise Browse/Install against the real index. Local `file://` index installs are covered end to end by a real-daemon test; the untested gap is browse-and-install _through the Settings UI_.

## Key decisions (do not relitigate)

- **A plugin is a manifest + self-contained HTML files**, served over the existing WebSocket RPC, not over HTTP. Kills the asset-server, auth-ordering, and relay problems in one stroke. Entries are flat `*.html` only.
- **Sandbox:** one model on every platform — `<iframe sandbox="allow-scripts">`, deliberately no `allow-same-origin`. Native puts that same iframe inside a host document in `react-native-webview`, with navigation locked and a postMessage relay to the bridge; it does not run the plugin as the top document (round 5 found out why). Guest CSP denies network; host CSP denies the frame navigating out.
- **Bridge is tiny on purpose:** `ready`/`init`/`update`/`open-file`. (`resize` was removed — nothing consumed it.) Widening it is a product decision.
- **Marketplace = a registry index JSON.** Install verifies SHA-256 per file.

## Traps

- Pre-commit runs a whole-repo typecheck; `--no-verify` only while agents have files in flight, and always run the full gate before pushing.
- Rebuild with `npm run build:client` / `build:server` before believing a cross-package type error.
- Never run the full test suite locally.
- `rg` returned false "0 matches" in this checkout at least once and caused a wrong conclusion. Prefer `grep`, and verify negative results before acting on them.
- Don't put a literal control character in a source file. A NUL used as a `join()` separator in `theme.ts` made git treat the whole file as binary — no diff, no PR line comments — and went unnoticed for two rounds. `"\u0000"` is the same byte and stays text.
- `HOSTILE_PLUGIN_HTML` in `sandbox-denial.browser.test.ts` is a template literal. A backtick in a comment inside it terminates the string and the failure reads as a syntax error hundreds of lines away.
- A new denial assertion must be shown to fail without its fix. Splice the mitigation out, watch it go red, restore. Two holes shipped behind assertions that could never have failed. `git stash` reverts the test file along with the fix, which quietly makes the "prove it fails" run a different, smaller suite — swap only the implementation file instead.
- The browser denial suite is a separate vitest project: `npx vitest run --project browser src/plugins/` from `packages/app`. A plain `npx vitest run src/plugins/` excludes `*.browser.test.ts` entirely and still looks green.
- Each `document.write` attack vector fires its own `load` event, so any assertion counting loads has to live in its own test with its own frame.
