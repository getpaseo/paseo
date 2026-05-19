# Pi RPC Provider Migration Plan

## Goal

Migrate the built-in `pi` provider from the embedded `@earendil-works/pi-*` SDK packages to a spawned `pi --mode rpc` process.

Pi remains a first-class provider in Paseo:

- Provider id stays `pi`.
- Existing agents and persisted Pi sessions continue to resume.
- Streaming, reasoning, tool calls, models, thinking level, slash commands, diagnostics, interrupts, and history replay continue to work.
- Users must have the `pi` binary installed and authenticated/configured. Paseo should no longer ship Pi's SDK/runtime packages inside `@getpaseo/server`.
- The final implementation must pass the targeted Pi suites during development and the full repo suite in CI.

## Implemented Shape

The active adapter is `packages/server/src/server/agent/providers/pi-rpc-agent.ts`.

It talks to Pi through one narrow port:

- `PiRuntime` starts and drives a Pi session with domain verbs.
- `PiCliRuntime` is the only production implementation; it spawns `pi --mode rpc`, frames JSONL, correlates responses, forwards events, and owns process lifecycle.
- `FakePi` is the only non-real Pi substitute in provider tests. It records launches and lets tests emit documented Pi events, but it must not simulate Pi agent/model/tool/retry/compaction/command behavior.

The server package no longer embeds Pi's SDK/runtime packages. Users must have the `pi` binary installed and authenticated/configured.

Pi behavior preserved by the RPC provider:

- Availability checks require a Pi binary plus at least one configured model/auth source.
- Model listing loads project extensions before returning models.
- Model ids are exposed as `provider/model`, with labels normalized to the model name.
- Thinking options are exposed for reasoning models and default to `medium`.
- Sessions persist through Pi's native session file and store `metadata.cwd`.
- Resume opens the previous Pi session file, preserving cwd override behavior.
- Streamed events map to Paseo timeline items:
  - text deltas -> `assistant_message`
  - thinking deltas -> `reasoning`
  - tool execution start/update/end -> `tool_call`
  - compaction start/end -> `compaction`
  - agent end -> `turn_completed` or `turn_failed`
- Historical messages replay as user, assistant, reasoning, shell, and tool-call timeline items.
- `setModel`, `setThinkingOption`, `interrupt`, `listCommands`, `getRuntimeInfo`, and diagnostics are provider features, not incidental helpers.

## Upstream RPC Contract

Pi `0.75.3` exposes `pi --mode rpc` over JSONL stdin/stdout. The protocol is documented in Pi's RPC docs.

Commands Paseo needs immediately:

- `prompt` with `message`, optional `images`, optional `streamingBehavior`
- `abort`
- `get_state`
- `get_messages`
- `get_available_models`
- `set_model`
- `set_thinking_level`
- `get_session_stats`
- `switch_session`
- `get_commands`
- optionally `compact` for replacing the local 413 recovery shim

Events Paseo already knows how to map because they are the same Pi session events the embedded adapter consumes today:

- `agent_start`
- `turn_start`
- `message_update`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `compaction_start`
- `compaction_end`
- `agent_end`

Important protocol detail: Pi RPC JSONL must split only on LF. Do not use Node `readline`; use a small strict JSONL reader like Pi's `attachJsonlLineReader`, or implement the same behavior in Paseo.

## Target Shape

The process-backed Pi provider uses these files:

- `packages/server/src/server/agent/providers/pi/runtime.ts`
- `packages/server/src/server/agent/providers/pi/cli-runtime.ts`
- `packages/server/src/server/agent/providers/pi/rpc-types.ts`
- `packages/server/src/server/agent/providers/pi/tool-call-mapper.ts`
- `packages/server/src/server/agent/providers/pi/history-mapper.ts`
- `packages/server/src/server/agent/providers/pi/test-utils/fake-pi.ts`
- `packages/server/src/server/agent/providers/pi-rpc-agent.ts`
- tests next to each module

The new adapter should keep one process boundary and one thin runtime port:

- `PiRuntime` is the single production port for "talk to a Pi session".
- `PiCliRuntime` is the real adapter that spawns `pi --mode rpc`, frames JSONL, correlates responses, and owns child-process lifecycle.
- `FakePi` is the only non-real Pi substitute in provider tests. Keep it thin: it records launches and lets tests script the same RPC-level events/results that real Pi emits, with a small reader-friendly wrapper over the protocol. It must not simulate Pi's agent behavior, model behavior, tool semantics, retries, compaction policy, or command execution.
- Session owns Paseo `AgentSession` behavior and event mapping.
- Client owns binary discovery, availability, diagnostics, model listing, session creation, and resume.
- Mapper modules own pure conversion logic from Pi RPC data to Paseo timeline/tool-call/runtime shapes.

Keep the current `pi` provider id. Do not introduce `pi-rpc` as a user-facing provider.

## Test Discipline

Apply these rules while implementing this plan:

- Tests are either pure/port-and-adapter unit tests or real E2E tests.
- No `vi.mock`, `vi.hoisted`, `vi.spyOn` of own exports, monkey-patched globals, raw child-process stubs in session tests, fake-server fixtures, or `__internals` exports.
- The Pi process is substituted only through the `PiRuntime` port.
- Tests talk to one handle, usually `FakePi` or a real daemon client.
- Test actions read as thin behavior at the Paseo/Pi boundary. Assertions should not match raw JSONL, request ids, serialized payloads, or private event arrays.
- The fake records observable state, not call counts. Prefer `expect(pi.recordedLaunches).toEqual(...)` over spy assertions.
- The fake is not a second implementation of Pi. If a helper needs branching, timing behavior, model/tool semantics, or its own tests, it is too thick; move that coverage to real E2E or shrink the seam.
- Keep raw protocol tests small and attached to `PiCliRuntime`; they prove adapter fidelity only, not provider behavior.
- Most confidence for Pi itself should remain in real E2E tests against an installed/authenticated `pi` binary.

## Phase 1: Runtime Port and CLI Adapter

Define `PiRuntime` around the caller's question: "start and drive a Pi session." Keep protocol details out of the provider session.

The port should expose domain-shaped operations:

- `startSession(input)` for create/resume/list-model probe launches.
- session methods for `prompt`, `abort`, `getState`, `getMessages`, `getAvailableModels`, `setModel`, `setThinkingLevel`, `getSessionStats`, `getCommands`, and `close`.
- an event subscription method that emits parsed Pi RPC events as typed values, not JSON strings.
- observable launch metadata for tests via `FakePi.recordedLaunches`.

Keep this port thin. It may hide JSONL framing, request ids, process lifecycle, and stderr handling. It should not normalize or reinterpret Pi behavior beyond parsing the documented RPC command/event shapes; that belongs in `PiRpcAgentSession` and the pure mapper modules where Paseo owns the conversion.

Implement `PiCliRuntime`:

- Spawn command defaults to `pi --mode rpc`.
- Honor provider runtime command replacement. If runtime settings provide a command, append `--mode rpc` unless the replacement already includes it by explicit local convention documented in tests.
- Pass runtime env merged over `process.env`.
- Set cwd to the agent cwd for session processes.
- Use strict JSONL reading on stdout.
- Buffer stderr with a limit.
- Correlate responses by string request id.
- Route non-response stdout objects as events.
- Support extension UI response writes, even if the first Paseo implementation auto-cancels unsupported dialogs.
- Reject all pending requests if the child exits or errors.
- Terminate with `terminateWithTreeKill` on close.

Adapter fidelity tests for `PiCliRuntime` should be deliberately small:

- A command resolves the matching response.
- Streamed events are delivered separately from responses.
- Response errors reject the domain operation.
- Child exit rejects pending operations and includes stderr.
- LF-only framing preserves Unicode line/paragraph separators inside JSON strings.
- Dispose terminates the child process tree.

Do not write broad provider behavior tests at the raw transport layer. Boundary tests belong at the `PiRuntime` seam with thin scripted `FakePi` events/results, and Pi behavior belongs in real E2E.

## Phase 2: Pure Mapping

The existing Pi mapping logic lives in pure modules before it reaches the runtime boundary.

Preserve or port:

- `transformPiModels`
- thinking option normalization and definitions
- prompt input conversion, including image blocks and rendered attachment text
- tool argument parsing for `bash`, `read`, `edit`, `write`, `find`, `grep`, `ls`
- legacy edit arg handling
- tool result text extraction and output summary
- event-to-Paseo timeline mapping
- history message replay mapping
- session stats to `AgentUsage`

Tests should stay focused on pure mapping behavior or the `PiRuntime` boundary. Do not recreate the old direct adapter as a fixture.

## Phase 3: RPC Session

Implement `PiRpcAgentSession` as the `AgentSession` implementation.

Startup:

- Ask `PiRuntime` to start a session with:
  - `--mode rpc`
  - `--model <provider/model>` when config has a model
  - `--thinking <level>` when config has `thinkingOptionId`
  - `--session <nativeHandle>` for resume, or `--session-dir` only if needed for tests
  - extension/tool/skill flags only when required by future runtime settings
- After spawn, call `get_state` and cache `sessionId`, `sessionFile`, model, thinking level, and cwd.
- If config has `systemPrompt`, pass it via `--append-system-prompt` or `--system-prompt` at process startup. Do not reintroduce reflection against Pi internals.

Turns:

- Generate Paseo turn ids locally, as the current direct adapter does.
- Subscribe to RPC events and map them to existing Paseo stream events.
- `startTurn` sends `prompt`.
- Because Pi's `prompt` response only means accepted/queued/handled, completion must still come from `agent_end`.
- Treat aborted prompt failures the same as today: emit `turn_canceled` for abort-like errors.
- Keep `run()` implemented by collecting stream events until `turn_completed` or `turn_failed`, same as the current adapter.

Session features:

- `interrupt()` sends `abort`.
- `setModel()` parses `provider/model`, sends `set_model`, then updates cached runtime info.
- `setThinkingOption()` sends `set_thinking_level`, defaulting invalid/null values to `medium`.
- `listCommands()` sends `get_commands` and maps extension/prompt/skill commands to `AgentSlashCommand`.
- `getRuntimeInfo()` uses cached state refreshed with `get_state` after model/thinking changes.
- `describePersistence()` uses `get_state.sessionFile` as `nativeHandle` and stores cwd metadata.
- `close()` disposes the `PiRuntime` session.
- `getAvailableModes()` stays `[]`; Pi still has no selectable modes in Paseo.

History:

- `streamHistory()` sends `get_messages`, then maps the returned `AgentMessage[]` with the same logic currently used for `this.session.messages`.
- If Pi RPC messages include branch/tree metadata that differs from direct messages, keep the initial implementation scoped to the currently active branch and add tests before supporting branches.

## Phase 4: RPC Client and Registry Swap

Implement `PiRpcAgentClient`:

- `createSession(config)` starts a new `PiRpcAgentSession`.
- `resumeSession(handle, overrides)` starts with `--session <handle.nativeHandle>` and cwd from override, handle metadata, or Pi state.
- `listModels(options)` should ask `PiRuntime` for a short-lived probe session in `options.cwd`, call `get_available_models`, map models, then dispose.
- `isAvailable()` should:
  - find the configured/default Pi binary
  - use the real `PiCliRuntime` to start `pi --mode rpc`
  - call `get_available_models`
  - return true only if at least one model is available
- `getDiagnostic()` should show:
  - binary path
  - version
  - configured providers from `get_available_models`
  - auth config path existence
  - model count or model-fetch error
  - status

`packages/server/src/server/agent/provider-registry.ts` uses `PiRpcAgentClient`.

## Phase 5: Package Cleanup

After the registry uses the RPC adapter and no server code imports Pi packages:

- Keep Pi SDK/runtime packages out of `packages/server/package.json`.
- Keep `package-lock.json` free of server-owned embedded Pi runtime dependencies.
- Keep direct-only provider code deleted after all reusable mapping has moved and all tests have been ported.
- Update `docs/providers.md` to describe Pi as a process-backed first-class direct provider, not embedded SDK.
- Update diagnostics/help copy so a missing Pi binary says the user must install `pi`.

## Compatibility Decisions

No WebSocket protocol change is required. This is a daemon-internal provider implementation swap.

Persisted Paseo agent records must remain compatible:

- Existing records have `provider: "pi"`.
- Existing persistence handles use `nativeHandle` for the Pi session file.
- Existing `metadata.cwd` should keep working.

If the new adapter needs a metadata marker, add it as an optional field. Do not make old metadata invalid.

Feature compatibility:

- There should be no degraded "old Pi SDK" fallback path in production. If `pi --mode rpc` is missing or too old, Pi is unavailable and diagnostics tell the user to update/install Pi.
- If a minimum Pi version is required, enforce it in `isAvailable()`/diagnostics and document it in `docs/providers.md`.
- Because this does not add a new client-visible feature, do not add `server_info.features.*`.

## Test Plan

Targeted development commands:

```bash
npx vitest run packages/server/src/server/agent/providers/pi-rpc-agent.test.ts --bail=1
npx vitest run packages/server/src/server/agent/providers/pi/cli-runtime.test.ts --bail=1
npx vitest run packages/server/src/server/agent/providers/pi/tool-call-mapper.test.ts --bail=1
npx vitest run packages/server/src/server/agent/providers/pi/history-mapper.test.ts --bail=1
npx vitest run packages/server/src/server/agent/provider-registry.test.ts --bail=1
npx vitest run packages/server/src/server/agent/providers/provider-availability.test.ts --bail=1
npx vitest run packages/server/src/server/agent/providers/provider-availability.posix.test.ts --bail=1
npx vitest run packages/server/src/server/daemon-e2e/pi.real.e2e.test.ts --bail=1
```

Required real Pi E2E coverage:

- Bash tool call detail and output.
- File read detail and content.
- File write detail and disk write.
- File edit detail and disk edit.
- Reasoning chunks for thinking-enabled runs.
- Persistence delete/resume.
- History replay after resume.
- Non-empty model listing.
- Runtime info reflects configured thinking level.
- `setThinkingOption()` updates runtime thinking level.

Default new provider behavior coverage to real Pi E2E. Use `FakePi` seam tests when the bug is deterministic at the Paseo/Pi boundary, expensive to force through a real model, or needs a process/RPC failure that would be hard to trigger reliably with the installed binary. Do not encode a richer Pi state machine in `FakePi` just to make a test easy.

Add new non-real tests for:

- Missing Pi binary -> provider unavailable and useful diagnostic.
- Old/unsupported Pi RPC -> provider unavailable and useful diagnostic.
- `listModels()` loads project extensions by spawning from the requested cwd.
- `resumeSession()` sends `--session <nativeHandle>` and preserves cwd metadata.
- `get_commands` maps extension, prompt, and skill commands.
- `get_messages` replays the same timeline as the direct adapter.
- Child process exit mid-turn emits a turn failure and leaves no pending request.
- Interrupt sends `abort` and maps Pi abort completion to Paseo cancellation.

These tests should use `FakePi` through `PiRuntime` except for the small `PiCliRuntime` adapter fidelity file. Avoid making a fake Pi process with protocol-shaped plumbing in each test, but also avoid a high-level Pi simulator. The fake should offer only thin helpers over documented RPC events/results and recorded launches.

Repo gates after implementation:

```bash
npm run build:daemon
npm run typecheck
npm run lint
npm run format
npm run format:check
```

Full-suite confidence should come from CI, not a local full test run. If the user explicitly requests local broad testing, run broad suites with output redirected to `/tmp` per `docs/testing.md`.

## Rollout Checklist

1. Land the `PiRuntime` port, `PiCliRuntime`, `FakePi`, and pure mapper tests with the direct adapter still active.
2. Land `PiRpcAgentSession` behind tests using `FakePi`, not a fake Pi RPC child.
3. Land `PiRpcAgentClient` model/availability/diagnostic tests.
4. Swap the provider registry to RPC.
5. Run the targeted Pi and registry tests.
6. Run the real Pi E2E file if credentials and `pi` are available.
7. Remove embedded Pi dependencies and direct-only code.
8. Update docs and lockfile.
9. Run typecheck/lint/format gates.
10. Push and let CI run the full suite.

## Known Risks

- Pi RPC `prompt` success is acceptance, not completion. Paseo must continue to wait for `agent_end`.
- Pi RPC does not expose the direct adapter's private system prompt mutation; startup args must carry system prompt behavior.
- Project extension loading depends on spawning from the correct cwd.
- `get_available_models` through a spawned process is heavier than in-process registry access; snapshot caching rules in `docs/providers.md` become important.
- Extension UI requests exist in RPC mode. Paseo must either map them to permission/user-input UX or cancel them predictably; it should not hang the Pi child.
- History replay depends on the exact RPC `AgentMessage` shape. Lock this with mapper tests before deleting the direct adapter.
- Child process lifecycle bugs can leak Pi subprocesses. `PiCliRuntime` adapter tests need exit, error, and dispose paths, while provider behavior stays at the `PiRuntime` seam.
