# Chat provider switching

Validated on macOS, based on Paseo 0.12.0 (`cafe4b01c`). This is an agent-assisted
implementation; the user also exercised the desktop app with configured providers.

## Workflow and evidence

The existing chat model picker starts inside the current provider. Back reveals the
enabled providers. Selecting another provider and model keeps the chat ID, route,
workspace and visible transcript. The first accepted message transfers bounded text
history and tool evidence. Private reasoning, historical image contents and native
runtime state do not transfer. Provider-specific controls reset to target defaults.

- [Desktop interaction recording](desktop.webm): switch, retained transcript, reload,
  switch back and send. [Screenshot after switching](desktop.png).
- [Narrow desktop recording](narrow-desktop.webm): the same workflow at 900 × 844.
  [Screenshot after switching](narrow-desktop.png).
- [Stale catalog recording](stale-catalog.webm): a real request is held while the
  daemon catalog changes; rejection displays an error, retains the source provider,
  and the source can still receive a message.

These recordings contain test fixture data, not private user conversations. Browser
coverage uses a real isolated daemon and renderer, a mock source runtime, and a
catalog-backed test target. It does not establish real-provider model quality.

## Automated commands and results

From `packages/server`:

```sh
../../node_modules/.bin/vitest run src/server/agent/agent-manager.test.ts src/server/agent/agent-loading.test.ts src/server/agent/provider-handoff.test.ts src/server/session/agent-config/agent-config-session.test.ts src/server/persistence-hooks.test.ts src/server/agent/agent-storage.test.ts
```

```text
Test Files  6 passed (6)
     Tests  265 passed (265)
```

Coverage includes same chat identity and workspace, unavailable/disabled targets,
registration rollback, concurrent prompts/switches, active turns and approvals,
bounded handoff, rejected-turn retry, echo suppression, segment refresh/rewind,
sidecar deletion, and restart with or without a native session handle. Restart tests
use new disk-store instances and no durable timeline store, matching the default
daemon configuration.

From `packages/client`:

```sh
../../node_modules/.bin/vitest run src/daemon-client.test.ts -t 'provider switching refuses'
```

```text
Test Files  1 passed (1)
     Tests  1 passed | 171 skipped (172)
```

From `packages/protocol`:

```sh
../../node_modules/.bin/vitest run src/messages.wire-compat.test.ts
```

```text
Test Files  1 passed (1)
     Tests  15 passed (15)
```

From `packages/app`:

```sh
E2E_RECORD_VIDEO=1 ../../node_modules/.bin/playwright test e2e/browser/chat-provider-switch.spec.ts --project=browser --workers=1
```

```text
3 passed (1.3m)
```

From the repository root:

```sh
npm run lint
npm run typecheck
npm run build:server
git diff --check
```

Lint: 0 warnings and 0 errors. All workspace typechecks passed. Server/dependency/CLI
build passed; the server was rebuilt after the final server changes. Desktop main
build passed at launch. Formatting and whitespace checks passed. The full repository
test suite was not run.

## Real-provider verification

A separate chat used configured Claude → Codex → Claude providers. Each phase was
instructed to use only conversation text, with no tools, files or memory writes.
Claude received a fresh random code, Codex correctly recalled it and received a
second code, then the chat switched back to Claude before the next message.

The final target had no native persistence handle and a pending handoff. After a
normal daemon restart, the same chat returned both codes correctly. The canonical
transcript retained the original messages and both switch notices, growing from
6 entries before restart to 8 after the reply, with 0 tool calls throughout.
Configured model names are routing IDs; model self-reports were not treated as
runtime identity verification. Private raw transcripts remain local.

The user also manually exercised Claude → Copilot → Codex and Codex → Claude in the
desktop app, including a directory-listing tool call and references to prior turns.

## Platforms and limits

| Platform        | Tested | Notes                                     |
| --------------- | ------ | ----------------------------------------- |
| Browser web     | Yes    | Desktop layouts: 1280 × 800 and 900 × 844 |
| Desktop macOS   | Yes    | Electron inspection and user manual tests |
| Desktop Windows | No     | Outstanding                               |
| Desktop Linux   | No     | Outstanding                               |
| iOS             | No     | Outstanding                               |
| Android         | No     | Outstanding                               |

A preliminary 390px browser run reached “Workspace unavailable”; its helper also
assumes the desktop popover. This remains an unresolved mobile-layout test scenario,
not passing mobile evidence. Final browser coverage stays at desktop breakpoints.

Switch notices currently use English daemon text and need localization/product
review. Historical images and provider-private runtime state are not transferred.
Earlier provider messages cannot be rewound by the current provider. Long handoffs
retain recent evidence and disclose shortened context. Once `startTurn` accepts the
handoff, asynchronous provider failures follow existing native turn/retry semantics;
only pre-acceptance rejection is guaranteed to keep the injection pending.
