# Transport CI triage

Reviewed CI run 35973248754 on d7c07411e; read-only source inspection at fb4f42001. The latter changes only client tests and evidence, so these server findings apply unchanged. No tests or edits were performed. Only the three assigned test files were diagnosed.

## T1: Two stale AgentManager fixtures prevent hello from completing (23 failures)

**Classification:** stale fixture, not an established production connection failure. S2/F0 → P2 for these developer test workflows, confidence 100, developer-only. Blocks green CI until fixtures and their existing tests pass.

`websocket-server.browser-tools.test.ts` has four connect timeouts; `websocket-server.relay-reconnect.test.ts` has nineteen null `server_info` assertions. Both fixture constructors omit `supportsToolCallSummaries` from their `createStub<AgentManager>` objects (browser-tools lines 275–300; relay-reconnect lines 242–257). `websocket-server.ts:1643` calls this method unconditionally while creating the initial server info. `test-utils/class-mocks.ts:41–43` throws on every unstubbed method invocation. The real `AgentManager` implements the method at `agent/agent-manager.ts:1174` and returns a boolean based on its summary store.

The hello path installs the session before constructing server info (`websocket-server.ts:1568–1575`). The throw reaches `handleRawMessageError`, which emits a status/error frame (`:2413`) instead of server info. Thus the mock-socket helper parses its first frame as null (`relay-reconnect.test.ts:418–420`, direct helper `:437–439`), while the actual DaemonClient in browser-tools waits until its 500 ms connect deadline. Increasing timeouts or changing first-message parsing would conceal the missing fixture method.

**Minimal fix:** add `supportsToolCallSummaries: () => false` to the browser-tools AgentManager fixture and `supportsToolCallSummaries: vi.fn(() => false)` to the relay-reconnect fixture. No fixture framework or production fallback needed. Existing feature assertions use individual properties, so adding the stub does not require wholesale expected-server-info rewrites.

**Causality:** `git blame` traces the server-info method call to 4f9a6f7395 (Add tool summaries, sleep prevention, history, and script search). That commit is an ancestor of BOTH premerge feature parent d7c07411e^1 and incoming 160430f94. Neither assigned fixture changed in the merge. This is shared preexisting test debt, not an integration-specific transport regression.

**Proposed verification (not run):** run each assigned fixture test file individually with vitest `--bail=1` after the two stub additions. No broad server suite is needed locally.

## T2: Sleep snapshot bypasses Hub permission filtering at hello and resume (3 failures)

**Classification:** production authorization inconsistency, not stale lifecycle expectations. S2/F0 → P2 for connecting/reconnecting sessions lacking daemon.read, confidence 100; blast radius single-user daemon. Actual population prevalence unknown. Blocks the existing Hub scope guarantee until corrected and its regressions pass.

Invariant: Hub sessions with only `hub.execute` receive common server info but do not observe daemon status requiring `daemon.read`. This is supported by `docs/permissions.md`, the outbound map (`authorization/operation-permissions.ts:406` assigns status to daemon.read, with only agent-created/failed exceptions at `:449–456`), and the existing Hub websocket test.

The CI log shows exactly one extra `sleep_prevention_changed` after each `server_info`: legacy hello fails `execution-session.websocket.test.ts:193`, normal hello fails `:211`, reconnect fails `:224`. `websocket-server.ts:1575` and `:1620` call `sendSleepPreventionState` after hello and resume. Its implementation (`:1852–1856`) calls `sendToClient` directly, which serializes to the socket without Session authorization (`:1117`). It exposes supported/active sleep-inhibition state and daemon agentCount. In contrast, subsequent sleep-state broadcasts use `broadcast` (`:1844–1845`), which calls `connection.session.publish` (`:930–934`), reaching the authorization check in `Session.emit` (`session.ts:7936–7939`). Ordinary state broadcasts therefore correctly withhold this data, while the initial snapshot leaks it.

**Minimal fix:** in `sendSleepPreventionState`, use the already attached connection and return unless `connection.session.allowsPermission("daemon.read")`. Then retain the existing send to the newly attached socket. Both hello/resume already install their socket mapping before this helper. Avoid changing global `sendToClient`, which intentionally carries hello server info and transport errors, and avoid Session.publish here because resumed connections may have multiple sockets and the snapshot belongs only to the attaching socket. Existing Hub expectations should remain unchanged.

**Causality:** both snapshot sends and the helper were added in 4f9a6f7395, already present in both premerge feature parent and incoming 160430f94. `git show 160430f94:packages/server/src/server/websocket-server.ts` confirms the same helper/callers. This is a preexisting permission bug surfaced by the comprehensive CI run, not caused by the latest merge.

**Proposed verification (not run):** rerun `hub/execution-session.websocket.test.ts --bail=1` after the guard. The existing failing tests cover legacy hello, normal hello and resumable hello without widening authority. Inspect an owner-authorized initial snapshot path to ensure daemon.read clients still receive state; optionally use existing focused sleep/bootstrap tests if already present. No broad authorization or infrastructure redesign is required.
