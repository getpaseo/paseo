---
name: verify
description: Drive the Paseo app (web or iOS simulator) to verify a change end-to-end — dev stack, seeded agents, Playwright/Maestro recipes, and the gotchas that cost hours.
---

# Verifying app changes at runtime

## Dev stack

```bash
npm run dev          # daemon on 127.0.0.1:6768, PASEO_HOME=.dev/paseo-home
npm run dev:app      # Expo web on http://localhost:8081, connects to 6768
```

Seed a chat with exact markdown (e.g. to exercise a renderer) with a cheap real
agent told to echo verbatim, or use the deterministic `mock` provider
(`ten-second-stream`, `one-minute-stream` — canned prose, cannot echo):

```bash
env -u PASEO_AGENT_ID npm run cli -- run --provider claude/haiku '<prompt>'
```

`PASEO_AGENT_ID` leaks from an agent-scoped session and points at the main
daemon — unset it or `create_agent` fails with "Caller agent not found".

## Web drive (Playwright)

The repo pins a Playwright whose browsers may not be in the local cache; skip
the download and use system Chrome: `chromium.launch({ channel: "chrome", headless: true })`.
Run scripts from the repo root so `./node_modules/playwright/index.mjs` resolves.

- `page.addInitScript` does NOT fire for `page.setContent` here — serve HTML
  via `file://` navigation instead when a stub must exist before page scripts.
- App flow: goto `localhost:8081` → click workspace name in sidebar → assert on
  `[data-testid="assistant-message"]`.
- Assistant chat markdown rules live in `message.tsx` (its `rules` object
  OVERRIDES `markdown/renderer.tsx` base rules — edit both or you'll only
  change non-chat surfaces).

## iOS simulator drive

```bash
cd packages/app && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
  EXPO_PUBLIC_LOCAL_DAEMON=localhost:6768 npx expo run:ios --device "iPhone 16 Pro"
```

Gotchas, in the order they bite:

1. **CocoaPods crashes** with `Unicode Normalization not appropriate for
ASCII-8BIT` on Homebrew Ruby 4 — always export `LANG=en_US.UTF-8`.
2. **No iOS destinations**: after an Xcode major update the iOS platform may be
   missing — `xcodebuild -downloadPlatform iOS` (~8GB) fixes it.
3. **Name-twin simulators**: expo may install to a different same-named device
   than the booted one. Install explicitly:
   `xcrun simctl install booted <DerivedData>/.../PaseoDebug.app` then
   `xcrun simctl launch booted sh.paseo.debug`.
4. `simctl openurl` with the exp+ scheme shows an un-scriptable "Open in Paseo
   Debug?" system dialog — prefer relaunching the dev client and tapping the
   `http://localhost:8081` server row.

Driving: Maestro (`~/.maestro/bin/maestro`) needs Java 17+
(`JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`).
Maestro sees only _booted_ sims (`xcrun simctl list devices booted`); pass
`--device <UDID>`. RN text nodes are often invisible to its text matchers —
fall back to `tapOn: {point: "x%,y%"}` from a `simctl io booted screenshot`.
First run shows the expo dev-menu sheet: tap "Continue", then close via the X.

`osascript` keystrokes are denied unless Paseo.app has the macOS Accessibility
grant — Maestro avoids needing it.
