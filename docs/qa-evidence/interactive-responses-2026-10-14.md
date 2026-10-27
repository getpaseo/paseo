# Interactive responses — local execution record

Approved handoff: `04eea85d-8531-46ad-99b5-7bc38d192b49`, plan
`01a13aed-8972-7fb1-a4e7-a51a2d9e8625-plan`. Base: `20863c767`.

The implementation was resumed on 2026-10-24. Custom JavaScript runs in an isolated QuickJS
WebAssembly worker behind DOM-filtered HTML/CSS/SVG rendering. The experimental opt-in is removed
from local source after Sylvain's explicit manual acceptance on 2026-10-26. New daemons advertise
`interactiveResponses`; older hosts still receive the app's update-host message. No installed app
was updated or published. Android is outside the accepted scope.

The automatic security audit remains incomplete. Manual acceptance replaces that gate only;
its failure is not recorded as a successful audit. Actual new-shell Electron QA and the user's
decision to proceed without a new physical iPhone run are distinguished below.

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
QuickJS, without network, DOM, filesystem, Electron or daemon bindings.

Do not trust htmlparser2 serialization as the DOM safety boundary: its HTML/SVG interpretation
can differ from the browser's. The shared iframe/WebView shell uses locally bundled
[DOMPurify](https://github.com/cure53/DOMPurify) at insertion time, for both initial content and every
worker render. Its positive tag/attribute policy preserves supported controls, styles and SVG;
resource/navigation restrictions and the CSP remain unchanged. Sanitized DOM nodes go directly to
morphdom without HTML reserialization. Keep that boundary when changing rendering.
`npm run build:interactive-runtime --workspace=@getpaseo/app` regenerates the common checked-in shell.

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

## Completion QA and review boundary — 2026-10-25

- Full Electron application, compiled main/preload and Electron Metro: rendering, controls,
  expansion, explicit submission, `CHOIX_RECU_12`, reload and native window hide/show restored
  count 12 and note `Essai iPhone`. Evidence: `/tmp/openui-full-desktop.log` and
  `desktop-journey.mjs`. CDP kept document visibility active while the native window was hidden;
  this proves restoration, not Electron worker teardown. Browser teardown was tested separately.
- Physical iPhone: five home/foreground cycles restored count 12 and the same note. Evidence:
  `/tmp/openui-ios-resume-journey.log` and `completion/ios-resume-results.json`. Hermes used heap
  after GC changed from 90,071,840 to 90,327,520 bytes; total heap from 117,440,512 to 113,246,208.
  These are Hermes measurements only. Instruments timed out, so native RSS, WKWebView and WASM
  memory are not measured. Screen locking was not automated.
- `verify-completion.mjs` exited 0: `completion/final-cross-platform-proof.json` confirms saved
  count 12, readable `Valider 12 : Essai iPhone` and `CHOIX_RECU_12`. The earlier daemon-restart
  proof for count 10 remains valid.
- The required final-review, deep and security profiles use their configured models and enforced
  `read_only` auditors. Startup was repaired without widening isolation: an autonomous Git copy
  outside the Paseo home and the public `/etc/ssl/cert.pem` trust bundle allow source reads and
  Codex routing. The original worktree remains the sole correction target. The snapshot at
  `/private/tmp/paseo-openui-review-z6khb8sp` matches the checkpoint plus owned delta, with hashes
  for the 5,833 source files of the preceding reviewed state in `external-review-snapshot.json`.
  The later manual DOM correction has its own manifest and has not been audited there. Auditors
  confirmed source reads while access to the Paseo home remained denied.
- Deep auditor `762db9e1-3f30-4898-b7db-0abfcbb6498f` identified four local defects. Corrections
  retain the shell until queued input is acknowledged on controlled hide/expansion, reject
  implicit field-name collisions, restore historical JSON containing a `proposal` property,
  and extract proposals only from declared visual fields. Targeted regressions cover these cases.
- Before interruption, security auditor `9eed94e7-d70f-488c-aa79-e40d5abb8478` reported a real
  HTML/SVG parser mismatch that could leave forbidden active/navigation elements in the DOM.
  The earlier manager summaries incorrectly omitted this finding and described only the filter
  blockage. The partial report is retained as a known defect, not a completed security audit.
  The auditor's active test and then its static-only continuation were rejected by the filter.
  Neither is retried or replaced; the interrupted test is not treated as successful evidence.
- On 2026-10-26, Sylvain expressly authorized a manual defensive correction of this finding:
  DOMPurify 3.4.17 in the common shell, a positive DOM policy and node-only insertion for all
  renders. This did not reset any review budget. Sylvain then accepted the concrete correction
  and local activation manually; the automatic security review remains incomplete.
- New evidence for that correction: three HTML/DOM unit tests and eight artifact tests pass;
  the regenerated shell passes offline Chrome controls (button, slider, textarea/focus), styles,
  SVG namespaces and state update to count 12, with zero external requests.
  Global typecheck/lint and formatting pass. No dangerous input or rejected test was reproduced.
  Commands, source hashes and the focused human-review diff are under `dom-hardening/` in the
  artifact directory. The later full Electron result and iPhone decision are recorded below.
- The initial deep re-review found that an errored expanded visual could no longer close.
  Sylvain explicitly authorized one additional correction/re-review cycle in the same run.
  Closing now waits for every visual's final state, then permits closing on failure while
  retaining the error and saved values. Explicit sending still requires successful flushes.
  The inert component regression first reproduced the failure, then passed with the correction;
  it also checks another visual's pending state and rejection of sending before/after closing.
- Delta checks and re-review outcomes are recorded in `final-review-checkpoint.json`,
  `extra-cycle/` and `validation/` under the ignored artifact directory. The earlier platform
  journeys predate these local corrections; they are not new device runs.
- Authorized local checkpoint `d9e0814b00937ccf62cb356e9935febc4e46ca15` contains exactly the
  34 captured implementation files, based on `60377e2e5ab97b49e8ba3589c31a17cf4c23f7f7`.
  Formatting made no changes; commit hooks passed global typecheck, scoped lint and formatting.
  QA artifacts are ignored and excluded. This subsequent evidence update is not committed.

## Manual acceptance and local activation — 2026-10-26

Sylvain answered “Valider manuellement et activer localement” to accepting the prepared correction
and local activation after Electron tests, replacing the blocked automatic security audit with
his manual validation. This authorizes local source activation only, without publication or an
installed-app update. Exact decisions: `dom-hardening/manual-approval-and-qa.json`.

The coordinator tested the full Electron application with production main/preload, updated Metro
on 63877 and isolated daemon 64361: interaction12→13, expansion, explicit `Valider13`,
`CHOIX_RECU_13`, reload and native hide/show restoration passed (exit0).
Driver: `dom-hardening-desktop.mjs`; log: `dom-hardening/electron.log`; inspected captures:
`dom-hardening/electron/desktop-expanded.png`, `desktop-confirmed.png`, `desktop-restored.png`.
This proves restoration, not worker teardown under CDP.

Asked for the iPhone to retest the changed shell, Sylvain answered “Considère que c'est vérifié”.
This is acceptance to proceed without a new physical test. Previous actual iPhone evidence stays
valid for its tested source state; no new iOS runtime validation is claimed.

Local activation removes the opt-in from capability advertisement, tool availability, agent
instructions, RPC handling and persisted-history restoration. Read-only tool restrictions and the
old-host capability check remain. Existing E2E fixtures no longer set the experimental variable.
The catalogue test creates a document with that variable absent. All 20 targeted activation tests,
server/app types, lint, formatting and diff checks passed. Final no-flag evidence is
`dom-hardening/normal-mode-final-evidence.json`; commands and exit codes are retained.

The coordinator started a fresh daemon from final TypeScript sources with
`env -u PASEO_EXPERIMENTAL_INTERACTIVE_RESPONSES`, home `.dev/openui-ios-home`, listening only on
127.0.0.1:64361. Absence of the variable was checked in the live process environment without
printing it. Runtime frame/render/generated-shell hashes match the hardened source state.
Live MCP catalogue and server capability checks passed (exit0); persisted state13 was restored.

In normal mode, Electron accepted interaction13→14, expansion and the explicit `Valider14` send.
`normal-desktop.mjs` exited1 only because `CHOIX_RECU_14` did not arrive within60 seconds; the
agent remained running, and an additional180-second wait did not finish. No resend occurred.
Independent native Codex session evidence records exactly one user message at
2026-10-26T15:09:23.634Z containing `Valider14` and selected state14. This proves provider receipt,
not an assistant response14. The earlier `CHOIX_RECU_13` result remains separate evidence.

Without resending, a fresh Electron process restored14, expanded/closed, reloaded and restored
again after native hide/show (`normal-desktop-restoration.mjs`, exit0). The final availability
check exited0 and verified state14, note `Essai iPhone`, one readable submission and native receipt.
The coordinator inspected `normal-electron/desktop-expanded.png` and `desktop-restored.png`.
Local activation is complete within the manually accepted scope; the model-reply delay remains
an explicit measurement limit, not a missing send/receipt result.

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

## Completion limits and delivery

- Local activation and final no-flag verification are complete. Manual acceptance replaces the
  automatic security gate; the blocked audit stays incomplete. No profile substitution or
  rejected test retry occurred. No assistant response14 was obtained within the observed delay.
- Android is outside the accepted scope. The iPhone and Electron evidence and measurement limits
  are recorded above; they are not claims of an extended native-memory soak or screen-lock test.
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
Electron evidence uses a separate full application, not the installed app. Native images below come from the
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
final isolated daemon restart. The 2026-10-25 captures are `completion/desktop-expanded.png`,
`completion/desktop-confirmed.png`, `completion/desktop-restored.png` and
`completion/ios-resumed.png`: expansion, confirmed receipt and restoration of count 12.
