# Interactive responses — local execution record

Approved handoff: `04eea85d-8531-46ad-99b5-7bc38d192b49`, plan
`01a13aed-8972-7fb1-a4e7-a51a2d9e8625-plan`. Base: `20863c767`.

This work is partial. Preserve it in the release with its capability, agent tool, prompt guidance,
RPC operations and deepening button disabled by default. Isolated development tests opt in with
`PASEO_EXPERIMENTAL_INTERACTIVE_RESPONSES=1`; normal installations must leave it unset.
Do not treat the approved feature as completed or enable it for this delivery.

## Implemented locally

- Shared OpenUI component schemas and source/state validation; common agent guidance and the
  policy-aware `render_interactive_response` tool.
- Agent-scoped atomic storage, revision conflicts, immutable selection snapshots, and persisted
  deepening context. Queued submissions retain their selected revision after another client edits.
- Optional wire references, namespaced get/update RPCs, client methods and the optional
  `interactiveResponses` host capability. Existing request fields remain accepted; app actions gate
  the new capability. The new `queue` send intent cannot replace a running turn.
- Native OpenUI text, layout, comparison, selection, form, slider, bar/line chart and existing Mermaid
  components. Interactive tool rows stay outside both ordinary tool groups and response folding.
  The engine loads when a visible card mounts.
- Coalesced form saves keep only the latest pending values behind an in-flight RPC, so slow
  connections do not accumulate a request per keystroke.
- Explicit sending through the existing composer submission/queue owners, preserving the draft.
  Pending, accepted, queued and error states remain distinct. Completed response footers expose
  “Explore further” / “Approfondir”. The daemon reconstructs the full historical response rather
  than trusting the client's mounted page, and attaches the associated document state as context.
- Inert HTML/CSS previews use a sandboxed iframe or native WebView. Generated scripts remain
  disabled, navigation/resource entry points are removed, and the UI explains the limitation.

## Functional blocker

The approved arbitrary HTML/CSS/JavaScript runtime is **not implemented**. Neither its serialized
state bridge nor its interaction proposal bridge is available. Enabling scripts in a `srcdoc`
iframe with CSP alone does not satisfy the no-network contract.

A Chromium probe against an isolated local HTTP server used `sandbox="allow-scripts"`,
`default-src 'none'`, `connect-src 'none'`, `base-uri 'none'`, and `form-action 'none'`. A script assigning
its own `location.href` still completed one HTTP navigation:

```json
{ "sandbox": "allow-scripts", "connectSrc": "none", "navigationRequests": 1 }
```

The tool instructions describe the implemented static subset. Full execution needs an offline
runtime that prevents navigation, not only a resource CSP. The current preview has no script bridge
and accepts no bridge messages.

## Validation

Run from the repository root unless a working directory is specified. Full suites were not run.

| Check                                                                                                  | Result                                                                                                                     |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run packages/protocol/src/interactive-response.test.ts --bail=1`                           | 4 passed: catalog, invalid/incomplete/oversized source, state values, provider result shapes                               |
| `npx vitest run packages/server/src/server/interactive-responses.test.ts --bail=1`                     | 1 passed: real filesystem, concurrent writes, old queued revisions, immutable snapshots, store recreation, agent ownership |
| `npx vitest run packages/server/src/server/response-context.test.ts --bail=1`                          | 1 passed: full historical response selection and associated documents                                                      |
| `npx vitest run packages/server/src/server/agent/agent-prompt.test.ts -t 'queue intent' --bail=1`      | 1 passed: active runs are never replaced                                                                                   |
| Server cwd: `npx vitest run src/server/agent/agent-manager.test.ts -t 'append system prompt' --bail=1` | 2 passed                                                                                                                   |
| Server cwd: `npx vitest run src/server/agent/providers/mock-load-test-agent.test.ts --bail=1`          | 17 passed                                                                                                                  |
| `npx vitest run packages/app/src/interactive-response/state-writer.test.ts --bail=1`                   | 3 passed: in-flight coalescing, settlement race, flush and conflict handling                                               |
| App cwd: targeted `html-policy.test.ts`, `composer/actions.test.ts`, `response-folding.test.ts`        | 56 passed, including stable queued request identities and visible error recovery                                           |
| App cwd: `npx playwright test e2e/browser/interactive-responses.spec.ts --project=browser`             | 2 scenarios passed with a real isolated daemon and real browser; deterministic provider executes the real tool catalog     |
| `npm run typecheck`                                                                                    | Passed after rebuilding workspace declarations                                                                             |
| `npm run lint`                                                                                         | Passed                                                                                                                     |
| Targeted `npm run format:files -- …` and `npm run format:check:files -- …`                             | Applied to this change only, preserving concurrent work                                                                    |
| Native Metro `expo export:embed`, entry `packages/app/src/interactive-response/card.tsx`               | iOS and Android bundles compiled; outputs under `packages/app/.artifacts/interactive-native/`                              |

Browser coverage includes generation, live/history rendering, conflict detection/reload, selection,
form state restoration, expansion, pending acknowledgement, accepted sending, provider consumption,
historical deepening, compact layout, dark theme, static HTML isolation, denied external resources
and ignored forged messages. Provider validation uses the deterministic development provider, not a
paid model. Store recreation tests are not a complete daemon process restart/reconnection test.

## Remaining validation and delivery

- Real Electron execution and iOS/Android device interaction, keyboard, touch, WebView navigation,
  reconnection/process restart, scroll stability and performance have not been signed off. No iOS
  simulator was booted and `adb` was unavailable during this execution. Native bundle compilation
  does not replace those checks.
- Arbitrary JavaScript/state restoration is blocked as described above. Do not publish this as the
  complete approved feature.
- OpenUI Lang Core 1.0.0 has opt-out installation telemetry. Dependency installation here used
  `--ignore-scripts`; only the repository patch script was run afterward. Set
  `OPENUI_TELEMETRY_DISABLED=1` for release-time dependency installation. Upstream runtime telemetry
  is opt-in and was not enabled; renderer observability is disabled.
- The release preparation preserves this work in a separate commit with default-off exposure,
  allowing Jalons to ship without activating an unfinished feature. Publication, installation and
  active-version verification are tracked with the Jalons delivery.
- Concurrent To-do work, including `packages/app/src/workspace-todos/`, its routes and related
  protocol/server changes, was preserved. Temporary incomplete files there interrupted one validation run; later global checks
  passed after that work advanced.

## Screenshots

Representative captures are in the Playwright output for `interactive-reviewed` (adaptive enlargement and completed form-save checks):

- `interactive-desktop.png`: structured response and accepted submission.
- `interactive-expanded.png`: enlarged structured response.
- `interactive-conflict.png`: concurrent edit error and reload.
- `interactive-mobile-web.png`: restored form in a compact browser viewport.
- `interactive-dark.png`: restored response in the dark theme.
- `interactive-html-inert.png`: static preview and explicit JavaScript restriction.

These are browser captures, not Electron or native device screenshots.

Raw validation logs are copied to `packages/app/.artifacts/interactive-responses-validation/`.
