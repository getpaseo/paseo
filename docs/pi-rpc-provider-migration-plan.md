# Pi RPC Provider Migration Plan

## Goal

Move the built-in `pi` provider off embedded Pi runtime packages and onto the user's installed `pi --mode rpc` binary.

The user-facing provider stays `pi`. Existing Paseo agent records and Pi session handles continue to resume through the same provider id.

## Final Shape

All Pi provider code lives in one module directory:

- `packages/server/src/server/agent/providers/pi/agent.ts` - Paseo `AgentClient` and `AgentSession` implementation
- `packages/server/src/server/agent/providers/pi/cli-runtime.ts` - production RPC process adapter
- `packages/server/src/server/agent/providers/pi/runtime.ts` - thin runtime port
- `packages/server/src/server/agent/providers/pi/rpc-types.ts` - Pi RPC data shapes
- `packages/server/src/server/agent/providers/pi/tool-call-mapper.ts` - pure tool-call mapping
- `packages/server/src/server/agent/providers/pi/history-mapper.ts` - pure history replay mapping
- `packages/server/src/server/agent/providers/pi/session-descriptor.ts` - persisted session discovery for import
- `packages/server/src/server/agent/providers/pi/test-utils/fake-pi.ts` - provider-test substitute at the runtime port

The server package does not depend on `@earendil-works/pi-*`. Users must have Pi installed and configured locally.

## Transport Seam

There is one intentional seam: `PiRuntime`.

`PiRuntime` starts and drives a Pi session with domain verbs such as `prompt`, `abort`, `getState`, `getMessages`, `getAvailableModels`, `setModel`, `setThinkingLevel`, `getSessionStats`, and `getCommands`.

`PiCliRuntime` is the only production implementation. It owns:

- spawning `pi --mode rpc`
- JSONL framing
- request/response correlation
- event forwarding
- stderr buffering
- child-process shutdown

The seam must stay thin. It may hide transport mechanics, but it must not become a second Pi implementation. Pi behavior belongs either in real Pi E2E tests or in Paseo-owned mapper/session code.

## Provider Behavior

`PiRpcAgentClient` owns binary discovery, availability checks, diagnostics, model listing, session creation, and resume.

`PiRpcAgentSession` owns Paseo session behavior:

- local turn ids
- stream event mapping
- run collection through `runProviderTurn`
- interrupt through Pi `abort`
- model and thinking updates
- runtime info caching
- persistence through Pi `sessionFile`
- history replay through `get_messages`

Pure mapper modules own conversions from Pi RPC data to Paseo timeline, tool-call, usage, and history shapes.

Import discovery reads Pi's persisted JSONL session files because Pi RPC does not expose a session-list command. Resume and full history hydration still go through `pi --mode rpc` using the discovered session file as `nativeHandle`.

## Compatibility

No WebSocket protocol change is required. This is a daemon-internal provider implementation swap.

Compatibility requirements:

- provider id remains `pi`
- existing persistence handles keep using `nativeHandle`
- existing `metadata.cwd` continues to work
- there is no production fallback to the old embedded runtime

If `pi --mode rpc` is unavailable or too old, Pi should be unavailable and diagnostics should tell the user what to fix.

## Test Discipline

Most confidence should come from real E2E tests against an installed/authenticated Pi binary.

Non-real tests are allowed only at two places:

- pure mapper tests
- provider/session tests through the `PiRuntime` seam using `FakePi`

`FakePi` records launches and lets tests script documented Pi RPC events/results. It must not simulate agent behavior, model behavior, tool semantics, retries, compaction policy, or command execution. If a test wants those semantics, it should be a real Pi E2E test.

Raw protocol tests stay attached to `PiCliRuntime` and should prove adapter fidelity only.

Targeted checks:

```bash
npx vitest run packages/server/src/server/agent/providers/pi/agent.test.ts packages/server/src/server/agent/providers/pi/cli-runtime.test.ts packages/server/src/server/agent/providers/pi/tool-call-mapper.test.ts packages/server/src/server/agent/providers/pi/history-mapper.test.ts packages/server/src/server/agent/providers/acp-agent.test.ts packages/server/src/server/agent/provider-registry.test.ts packages/server/src/server/agent/providers/provider-availability.test.ts packages/server/src/server/agent/providers/provider-availability.posix.test.ts --bail=1
npx vitest run packages/server/src/server/daemon-e2e/pi.real.e2e.test.ts --bail=1
npm run typecheck --workspace=@getpaseo/server
npm run lint
npm run format
npm run format:check
npm run build:daemon
```

Full-suite confidence should come from CI, not a local full test run.

## Known Risks

- Pi RPC `prompt` success means accepted/queued, not turn completion. Paseo must still wait for `agent_end`.
- Project extension loading depends on spawning from the requested cwd.
- Model/history/session behavior depends on Pi RPC schema compatibility.
- Extension UI requests must be canceled or mapped predictably so the child process does not hang.
- Child process lifecycle bugs can leak subprocesses; `PiCliRuntime` tests should cover exit, error, and dispose paths.
