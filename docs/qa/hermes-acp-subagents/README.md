# Hermes ACP subagent QA

Every displayed reply is scripted and explicitly labeled `[NO-MODEL FIXTURE]`. These are actual app screenshots and recordings, not UI-injected events or real model output.

Tested on macOS 27.2 / Apple Silicon / Chrome 155. The executable Python fixture uses the companion Hermes checkout's real ACP server, callback wiring, relay, journal and serializer. Paseo launches it as a configured generic ACP provider; notifications travel through the actual daemon, WebSocket client and existing provider-subagent panels.

## Reproduce

From `packages/app`, after normal workspace setup and Playwright browser installation:

```sh
E2E_RECORD_VIDEO=1 npx playwright test e2e/browser/hermes-subagents.spec.ts --project browser --workers 1
```

This default uses the self-contained Node contract fixture committed with Paseo. To exercise both repositories together, set `PASEO_HERMES_ACP_FIXTURE_PYTHON` to a Hermes test interpreter with the ACP extra and `PASEO_HERMES_ACP_FIXTURE_SCRIPT` to `tests/acp_adapter/fixtures/subagent_agent.py` in the companion checkout, then run the same command. The test creates an isolated temporary `HERMES_HOME` and workspace.

Local verification used installed Chrome through a temporary Playwright config and the installed FFmpeg through a temporary tooling directory because the bundled binaries were unavailable. Those machine-specific overrides are not committed.

## Observed behavior

Three simultaneous children appear as two root rows and one nested child. The root turn finishes while all three remain running. Opening alpha shows its public reply and `Started tool: terminal`; opening its nested child shows that child's own reply and `Started tool: read_file`. No child Stop button is offered. A second root turn reports completed, failed and canceled through callbacks retained from the first turn. Browser reload retains the selected child's public output and daemon timeline.

- [Light desktop running list](desktop-light-running.png), [nested panel](desktop-light-nested.png), [after reconnect](desktop-light-reconnected.png), [recording](desktop-light.webm).
- [Dark desktop running list](desktop-dark-running.png), [nested panel](desktop-dark-nested.png), [after reconnect](desktop-dark-reconnected.png), [recording](desktop-dark.webm).
- [Compact running list](compact-light-running.png), [nested panel](compact-light-nested.png), [after reconnect](compact-light-reconnected.png), [recording](compact-light.webm).

## Automated results

- Plugin reducer + ACP connector: 2 files, 40 passed (18.13s).
- Built-in ACP adapter + capability/child-history tests: 2 files, 117 passed (3.88s).
- Self-contained Node fixture UI: 3 passed (53.2s).
- Real Hermes fixture UI: 3 passed (55.0s); desktop light/dark and compact layouts.
- Plugin, server and app typechecks: exit 0.
- Changed TypeScript/fixture lint: 0 warnings, 0 errors; formatting check passed.

Regression proof on base `29db2b7`: both new ACP connector tests fail. The background test never receives a child terminal event; load emits only the root instead of root plus restored child. Both pass on the branch. Validator tests also cover duplicate/older sequences, terminal non-revival, malformed identities, wrong depth, cycles, child-before-parent ordering, unknown-version fallback, and transport loss.

## Limits

No model/network inference ran. Native iOS, Android, Electron, Linux and Windows were not tested. Browser reconnect is exercised end to end; ACP load replay and cold journal restore are covered by focused behavior tests. This is bounded public visibility, not a complete transcript archive or a child-control protocol. See the [shared v1 contract](../../hermes-acp-subagents.md).
