# Incoming prompts during Codex compaction

Initial verification on macOS on 2026-10-05, against baseline `f02cc16` and native `codex-cli 0.159.2`. Review corrections verified on 2026-10-06 against PR head `1cd3932`.

## Reported failure and confirmed cause

A production Paseo 0.11.0-beta.3 session repeatedly aborted automatic Codex compaction when background agents sent updates. Ten aborted compactions followed `send_agent_prompt` calls within two seconds. One example was a send at 21:11:42.501 UTC followed by a native turn abort at 21:11:42.619 UTC. The installed daemon bundle was inspected, not just this checkout: its MCP send path passed `replaceRunning: true`, and replacement interrupted the active native turn. Those incoming updates therefore interrupted the summarization that Codex needed to continue.

Separately, the Codex adapter completed pending compaction markers before checking whether the native turn had failed or been interrupted. That made an aborted compaction look successfully compacted in the timeline. Repeated provider-driven compaction without incoming updates is not explained by this evidence.

Review identified two additional causes in the queued path. MCP excluded `queued` prompts from the blocking wait, so a top-level caller returned before its prompt ran and received no answer. The manager also canceled pending prompts on every failed or canceled turn, including a turn ending after compaction had already succeeded. When steering was unavailable, that discarded a prompt that should have started next. New regressions failed with each affected implementation from `1cd3932` for the reported reason; raw output is in [review-checks.txt](review-checks.txt).

The original regression test was run with `agent-manager.ts` and `agent-prompt.ts` temporarily restored to baseline, then the edited bytes were restored. It failed on the first compacting update:

```text
FAIL src/server/agent/agent-manager.test.ts > queues incoming prompts through auto compaction and steers them FIFO
AssertionError: expected { disposition: 'turn_started' } to deeply equal { disposition: 'queued' }
- "disposition": "queued",
+ "disposition": "turn_started",
Test Files  1 failed (1)
Tests       1 failed | 197 skipped (198)
```

## Result and automated coverage

A runtime FIFO intercepts the shared prompt dispatcher before steer/replacement, including manual `/compact` admission before native events arrive. Messages resume in order after compaction, steering the current turn or waiting for its completion if steering is unavailable. No queued message uses interrupt-and-replace. Explicit Stop, runtime closure, or an unsuccessful active compaction cancels pending messages with a timeline warning. Ambiguous delivery failures are reported without automatic retries. Finish notifications are armed only after delivery; the original turn cannot prematurely satisfy the queued task. Blocking MCP calls wait for delivery before waiting for the resulting turn, sharing the existing 30-second budget. Queue cancellation or ambiguous delivery failure settles that wait with an error. A timeout before delivery reports `queued: true` and leaves an agent-scoped finish notification deferred until delivery. Failed or canceled turns after successful compaction release pending prompts into the next turn; they no longer cancel the queue.

The focused suites exercised real manager/storage code and the actual Codex adapter with deterministic native events. An HTTP test additionally ran an isolated daemon and MCP client over Streamable HTTP, submitting two updates during native compaction and asserting zero `turn/interrupt` requests and ordered `turn/steer` inputs afterward. The native app-server transport in that HTTP test is a fixture; it is not a live-provider claim.

Commands were run from `packages/server`, `packages/app`, or `packages/protocol` as appropriate:

```sh
# Server: 534 tests
npx vitest run src/server/agent/agent-manager.test.ts src/server/agent/compaction-prompt-queue.test.ts src/server/agent/agent-prompt.test.ts src/server/agent/mcp-server.test.ts src/server/agent/activity-curator.test.ts src/server/agent/providers/codex-app-server-agent.test.ts --maxWorkers=1 --bail=1
# App: 79 tests
npx vitest run src/components/message-compaction-label.test.ts src/types/stream.test.ts src/types/stream.harness.test.ts src/plugins/timeline/projection.test.ts --maxWorkers=1 --reporter=verbose
# Protocol: 15 tests
npx vitest run src/messages.wire-compat.test.ts --maxWorkers=1
# HTTP: one selected test; other parity cases intentionally skipped
npx vitest run src/server/agent/mcp-parity.e2e.test.ts -t 'HTTP MCP queues' --maxWorkers=1 --bail=1
# Live provider: one selected test; unrelated provider cases intentionally skipped
npx vitest run src/server/agent/providers/codex-app-server-agent.real.e2e.test.ts -t 'delivers a queued prompt after real manual' --maxWorkers=1 --bail=1
```

Review corrections: **336 tests passed** across the three changed suites (`agent-manager.test.ts`, `mcp-server.test.ts`, and `compaction-prompt-queue.test.ts`). Eleven new cases cover top-level and explicitly blocking agent-scoped answers, Stop, closure, unsuccessful compaction, queued timeout notification timing, and failed/canceled turns before and after compaction. The existing ambiguous-delivery test now verifies that every pending delivery wait receives an error. The MCP suite's 131 tests passed again after the implementation edit and after replacing conditional test-case selection with fixed inputs and cancellation actions required by review. Repository-wide lint, the server build, server typecheck, and changed-file format checks passed; full typecheck retains the two local errors listed below. Commands and output: [review-checks.txt](review-checks.txt). These corrections were fixture-tested on macOS; no additional live-provider or UI run was performed.

Initial verification: **630 distinct focused tests passed in the commands above**. Selected raw runner output and live event output are in [checks.txt](checks.txt).

The live check used the installed native Codex binary and existing subscription authentication, an empty temporary directory, and a separate app-server process. It seeded a conversation with `SEED_OK`, admitted `/compact`, immediately submitted a replacing follow-up, observed `queued`, then observed loading/completed compaction, a normal terminal event, and the follow-up answer `QUEUE_DELIVERED_OK`. No turn was canceled or failed. This was run once as an ad hoc program and again as the committed real-provider regression test. It verifies manual compaction with a live provider; automatic compaction injection and failure paths use deterministic fixtures.

## Compatibility and checks

The compaction wire status remains `loading | completed`. Optional `outcome: canceled | failed` conveys unsuccessful termination without adding enum values that old clients reject. The protocol test parses the new row with a legacy-shaped schema. New app code also accepts old daemon rows without `outcome`; their historical success/cancellation ambiguity cannot be reconstructed. An old app parses new rows but requires an app update to display their unsuccessful outcome.

`npm run build:server`, server typechecking, changed-file lint, and changed-file formatting checks passed. Full `npm run typecheck` was run after dependency declaration builds and still fails in untouched areas:

- `packages/app/src/components/draggable-list.native.tsx:122`: installed native list dependency does not accept `dragGestureHostPresented`.
- `packages/website`: missing `@cloudflare/workers-types` in the local installation.

No pre-commit hook is installed in this checkout; typechecking, lint, and formatting checks were run directly. The production desktop application and daemon were not replaced or restarted.

## Platform coverage and remaining verification

| Platform                       | Coverage                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------- |
| macOS daemon                   | Focused server suites, isolated HTTP daemon, live native Codex manual compaction |
| Web app                        | Label and stream reducer tests; no browser screenshot or interaction run         |
| Electron macOS                 | No packaged app/UI run                                                           |
| iOS / Android                  | No simulator/device run                                                          |
| Windows / Linux daemon and app | Not run                                                                          |

The app change passes the outcome through existing marker rendering and changes its text. Visual proof of the longer translated failure labels on web, desktop, and mobile is not supplied. No claim is made that every Codex compaction loop has this cause. Queued prompts are runtime-only and do not survive a daemon restart.
