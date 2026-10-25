# Interactive responses — local execution record

Approved handoff: `04eea85d-8531-46ad-99b5-7bc38d192b49`, plan
`01a13aed-8972-7fb1-a4e7-a51a2d9e8625-plan`. Base: `20863c767`.

The implementation was resumed on 2026-10-24. Custom JavaScript now runs in an isolated
QuickJS WebAssembly worker behind filtered HTML/CSS/SVG rendering. Normal installations still
leave `PASEO_EXPERIMENTAL_INTERACTIVE_RESPONSES` unset: Android device validation, full Electron
lifecycle validation and the required Paseo final review remain outstanding. Do not announce the approved feature as completed.
Development checks opt in with `PASEO_EXPERIMENTAL_INTERACTIVE_RESPONSES=1`.

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
- DOM updates preserve keyed controls during continuous slider gestures. Delegated events include
  multiline input; browser regressions cover both cases.
- Custom visuals use a trusted iframe/WebView shell and a separate QuickJS worker. Generated
  scripts receive serialized events and a bounded rendering/state/proposal API, never browser
  objects. Each mounted visual owns its worker; failures destroy it and expose retry.
- The renderer uses OpenUI’s runtime and render-node hook without its DOM presentation; even the
  package’s native entry otherwise emits `div` elements. A regression checks the container boundary.
- Submitted proposals use readable text. Provider message identities preserve that text during
  history replay; hidden snapshot attachments stay in agent context across daemon restarts.
- Sending waits for a worker barrier before flushing saves and selecting a revision. That barrier
  stops animation timers so later ticks cannot change the confirmed decision. Proposals are
  visible outside the visual and never send messages themselves.

## Execution boundary

Do not enable browser JavaScript for generated HTML. A script can navigate its own iframe despite
`connect-src 'none'`; the original Chromium probe observed a completed HTTP navigation with that
policy. The shell instead executes only its hashed trusted bootstrap. Generated scripts run in
QuickJS, without network, DOM, filesystem, Electron or daemon bindings. Every rendered update is
filtered and remains under the shell's resource CSP. The same shell is bundled for web and native;
`npm run build:interactive-runtime --workspace=@getpaseo/app` regenerates its checked-in HTML.

The supported API is defined in the shared catalog in
`packages/protocol/src/interactive-response.ts`. This is a Paseo visual runtime, not compatibility
with arbitrary browser pages or external JavaScript libraries. Source and runtime assets are
self-contained; no CDN or runtime download is required.

## Resumption evidence — 2026-10-24

| Check                                                 | Result                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App artifact/state/HTML/interpreter unit files        | 16 passed, including native container boundaries, prepared text, legacy state, blocked host APIs, loop interruption, memory/output/timer bounds and isolated lexical scope                                                                     |
| Protocol and server document/context files            | 9 passed, including named visuals, immutable choices and store recreation                                                                                                                                                                      |
| `packages/client/src/daemon-client.test.ts`           | 161 passed; old release failures preserve replacement transports, and failed registrations do not poison later cleanup                                                                                                                         |
| Browser `interactive-responses.spec.ts`               | 4 passed: structured history/deepening, scripted controls, keyboard focus, background teardown/restoration, explicit sending, resource/bridge filtering, error/retry and default-off behavior                                                  |
| Real Codex `interactive-responses.codex.real.spec.ts` | Passed with the configured `gpt-6.1-sol` model: generates a custom visual, receives the confirmed count, then restores the response, selected state and readable submitted text after an isolated daemon process restart                       |
| Separate Electron runtime                             | Passed: SVG, controls, bounded animation, saved state and prepared proposal                                                                                                                                                                    |
| Physical iPhone 17 Pro Max (iOS 27.0.1)               | Passed: QuickJS/WebView rendering, button and continuous slider drag, keyboard/SwiftKey input, expansion/close, app relaunch restoration, confirmed choices `CHOIX_RECU_9`/`CHOIX_RECU_10`, readable submission and state after daemon restart |
| iOS and Android Metro bundles                         | Compiled on the final runtime; not device interaction evidence                                                                                                                                                                                 |
| Typecheck, lint and formatting                        | Global checks run; final app/server typechecks and affected-file lint passed after corrections. Formatting and diff checked                                                                                                                    |

The canonical-history regression and store persistence checks also pass. They match provider
message identities, never prompt-text prefixes. Pre-fix QA messages already reconstructed without
the display mapping remain unchanged; the final native submission is stored and restored cleanly.

The deterministic mock provider keeps its history in memory. Process-restart UI evidence therefore
uses the real provider; store-only recreation checks stay in the server suite. Restarting the test
worker also requires reconnecting its seeding clients before fixture cleanup.

The client suite's existing hello expectation omitted the already-advertised
`workspace_conflict_model` capability; that stale expectation was corrected without changing the
advertised capabilities.

Chrome is selected through an artifact-only Playwright config because this checkout's expected
Chromium binary is unavailable. Electron evidence comes from a separate isolated process, not the
installed Paseo app or main daemon. No publication, installed Mac app rebuild or main-daemon restart was performed. The user separately
authorized a native iOS test build and installation on the unlocked paired iPhone.

Current artifacts, isolated runtime drivers and browser configuration live under
`packages/app/.artifacts/openui/`. Final command logs are copied to its `validation/` directory.

## Original validation — 2026-10-14

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

- Complete actual Android keyboard, touch, WebView, reconnection and performance validation.
  iOS functional checks ran on the physical device; interruption/performance soak remains limited.
  Check the full Electron application lifecycle in addition to the isolated runtime proof.
- Complete the required Paseo final review. Its inventory lacks `paseo-workflow-final-review`,
  `paseo-workflow-audit-deep` and `paseo-workflow-audit-security`. The skill forbids a replacement
  profile. Repair through Settings → Plugins → paseo-workflow → Workflow profiles → Install / repair
  profiles before lifting this gate.
- Keep publication, Mac installation and main-daemon restarts outside this local implementation task.
  The separately authorized iOS test app compiled and installed successfully on the physical
  iPhone 17 Pro Max (iOS 27.0.1). After unlocking and enabling host Developer Tools security, XCTest inspection and
  actual WebView interaction succeeded. The required test runner is separately signed. It uses a unique local identifier because `sh.paseo.debug` is
  reserved by another signing team. Remote notifications are disabled only in its ignored generated
  Xcode project; tracked app configuration and the production iPhone app remain unchanged.
- OpenUI Lang Core 1.0.0 has opt-out installation telemetry. Set `OPENUI_TELEMETRY_DISABLED=1` for
  release-time dependency installation. Dependency installation for this resumption used
  `--ignore-scripts`; runtime renderer observability remains disabled.

## Screenshots

Artifacts live under `packages/app/.artifacts/openui/`. Browser compact captures are viewport tests;
Electron evidence is an isolated runtime, not the installed app. Native images below come from the
physical iPhone. In the last capture, the old pre-fix QA message remains above the clean final send.

| Native keyboard                                                          | Expanded visual                                                           | Restored after app relaunch                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| ![SwiftKey input](../../packages/app/.artifacts/openui/ios-keyboard.png) | ![Expanded visual](../../packages/app/.artifacts/openui/ios-expanded.png) | ![Restored state](../../packages/app/.artifacts/openui/ios-restored.png) |

| Reconnection during isolated restart                                       | Agent receipt after final restart                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ![Reconnection](../../packages/app/.artifacts/openui/ios-reconnecting.png) | ![Confirmed receipt](../../packages/app/.artifacts/openui/ios-final-received.png) |

| Real agent/browser after daemon restart                                                                                                                                                | Isolated Electron simulation                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| ![Restored real visual](../../packages/app/.artifacts/openui/display-final-real/interactive-responses.code-1eb96-s-an-isolated-custom-visual-real-provider/interactive-real-agent.png) | ![Electron simulation](../../packages/app/.artifacts/openui/electron-simulation.png) |

Browser card, expansion and compact captures are also available under `nativefix-browser/`.
`ios-final-proof.json` verifies count10, note, readable submitted text and agent receipt after the
final isolated daemon restart. Full Electron application lifecycle and Android device interaction
remain outstanding.
