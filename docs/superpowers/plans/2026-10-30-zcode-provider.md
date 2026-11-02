# ZCode Provider Implementation Plan

> **Status:** implemented. The legacy transport and the provider connection shipped in this plan's tasks 1–10. This document keeps the decisions and the constraints; the implementations live in the source files it names, and the design record lives in the spec.

**Goal:** Add a bundled Paseo plugin that drives ZCode over its existing `zcode app-server --stdio` protocol, so Paseo can open a ZCode session, stream replies, render tool calls, answer permissions, switch model and mode, and list and restore sessions — with the ZCode repository unmodified.

**Architecture:** The plugin owns its transport, session state, catalog and capabilities, following the `plugins/antigravity-provider/` pattern. ZCode's two protocol generations sit behind one `ZCodeTransport` interface; the legacy implementation landed first, and the V4 implementation is a separate plan.

**Spec:** `docs/superpowers/specs/2026-10-30-zcode-provider-design.md`

## Global Constraints

- The ZCode repository is read-only for this work. Nothing here edits it.
- The provider ships as a bundled plugin under `plugins/zcode-provider/`. Paseo core gains no provider manifest entry, no provider factory, and no protocol-layer provider id. It is registered through the `builtinPlugins` list in `packages/server/src/server/plugins/builtin/index.ts`.
- Provider protocol version stays `1`. `PROVIDER_PROTOCOL_VERSION` in `packages/plugin/src/server/provider.ts` is not changed.
- The legacy transport declares exactly the capabilities in `plugins/zcode-provider/server/capabilities.ts`. It does not declare `session.revert.*`, `prompt.steer`, `prompt.output_schema`, `prompt.command` or `prompt.image`.
- A declared capability is a promise the daemon trusts. The daemon routes a command or image prompt to the provider and rejects it only if the capability is absent, so declaring one the transport cannot honour turns a clean rejection into a runtime failure. The legacy transport carries text only, and the session rejects a command or a non-text part outright rather than pretending to handle it.
- Binary resolution order, first match wins: the user's `agents.providers.zcode.command` override, then `zcode` on `PATH`, then the runtime bundled in the ZCode desktop app under `resources/glm/`, then the `GLM_BINARY_PATH` environment variable. The order lives in `plugins/zcode-provider/server/internal/binary.ts`.
- A JavaScript runtime cannot be launched directly: Windows refuses a CommonJS file as an executable, and a POSIX build is not executable either. Both the desktop bundle and a JavaScript `GLM_BINARY_PATH` run as `{ command: process.execPath, args: [bundlePath, "app-server", "--stdio"], env: { ELECTRON_RUN_AS_NODE: "1" } }`.
- The `resolveCommand` hook carries no environment: it returns the command and its arguments only. The plugin merges `ELECTRON_RUN_AS_NODE` at its own spawn site, keyed off the launch it was actually handed, because a user override can replace the command the hook resolved.
- ZCode frames are `{ id, method, params? }` for requests, `{ id, result }` for responses, `{ id, error: { code, message, data? } }` for failures, and `{ eventId, sessionId, turnId?, seq, timestamp, type, payload? }` for events.
- Every frame decoder is tolerant. Unknown fields are dropped, unknown event types are ignored, and a structurally broken frame does not end the connection.
- ZCode delivers legacy events by cursor, not by push. Each session polls `session/events` with an `afterSeq` cursor.
- ZCode asks the host for permission with a reverse request, `interaction/requestPermission`, and waits for that request's answer. There is no `interaction/respond` method to call instead.
- ZCode owns its own authentication. No test carries an auth check, an environment gate, or a conditional skip.
- Tests use the two categories in `docs/testing.md` and nothing else: unit tests with injected ports, and real end-to-end tests. No `vi.mock`, no JSDOM, no component mounting.
- The stop boundary is a hard requirement, not a refinement: a cancel that never settled must block new runs.

## Review Focus

Five input classes the spec implies that no happy path exercises. Each one has a test in the module that owns the code.

1. **A ZCode event carrying a field the provider does not know.** ZCode's schemas are strict and keep gaining fields, and one dropped field must not drop a whole turn. Expected: the event still reaches the timeline. Tested in `plugins/zcode-provider/server/internal/wire.test.ts`.
2. **Stop pressed twice.** The second press must retry the cancel that is already in flight, not open a second one that kills the next turn. Expected: exactly one cancellation reaches ZCode. Tested in `plugins/zcode-provider/server/internal/session.test.ts`.
3. **A prompt sent while a cancel is still settling.** Expected: refused, with the refusal reported, and the run does not start. Tested in `plugins/zcode-provider/server/internal/session.test.ts`.
4. **The ZCode binary missing.** Expected: the provider is unavailable with a diagnostic naming all four resolution paths, and the daemon does not crash. Tested in `plugins/zcode-provider/server/internal/binary.test.ts`.
5. **A permission option whose answer carries `permissionUpdates`.** Expected: the rule change reaches ZCode intact, so "always allow" survives the round trip. Tested in `plugins/zcode-provider/server/internal/signals.test.ts`.

---

## Task 1: Core — launch resolution honors a user override and a plugin-supplied command

The plugin needs to own binary discovery, and the daemon needs to keep owning the environment. Before this task neither was possible: `resolveLaunch` returned `undefined` before it read the user's override, and it threw before the plugin's `status` could run.

**The plugin's `ProviderRegistration` object lives in the plugin's child process.** The daemon never holds it. `packages/server/src/server/plugins/index.ts` rebuilds a proxy registration from the metadata the plugin sent, and every callback on that proxy is a message across the plugin IPC bridge. A new provider callback is therefore a bridge change, not just a type change: the SDK type, the process protocol, the plugin-side handler, the daemon-side request, and the proxy all move together. A hook that only exists in the SDK type is inert.

**Files:**

- `packages/plugin/src/server/provider.ts` — the `resolveCommand` hook on `ProviderRegistration`
- `packages/server/src/server/plugins/plugin-process-protocol.ts` — the metadata field and the `provider.resolve_command` request
- `packages/server/src/server/plugins/plugin-process.ts` — validate the callback at registration, advertise it, answer the request
- `packages/server/src/server/plugins/runtime.ts` — the daemon-side request
- `packages/server/src/server/plugins/index.ts` — the runtime port and the proxy callback
- `packages/server/src/server/agent/plugin-provider.ts` — one launch resolution order

**Tests:** `packages/server/src/server/agent/plugin-provider.test.ts` and `packages/server/src/server/plugins/index.posix.test.ts`.

**Design notes:**

- `providerOverrides.<id>.command` is the user-facing setting and is a string array; the registry turns it into a `replace` command. `runtimeSettings.<id>.command` carries the `append` mode. The two are different sources, and a test that uses the wrong one proves nothing.
- `ProviderCommand` has three modes. Only `replace` replaces the command, so only `replace` short-circuits the plugin's own resolution. `default` and `append` keep the plugin's command and add the override's arguments to it. `resolveProviderLaunch` throws when `defaultBinary` is undefined and the mode is not `replace`, so the `replace` branch is the only one that may omit `defaultBinary`.
- The bridge test in `index.posix.test.ts` is the one that proves the hook survives the trip through the plugin process. A test that only exercises an in-process registration object proves nothing about the bridge.
- `isResolvedCommand` lives in `plugin-process-protocol.ts` so the plugin side and the daemon side share one definition.

This commit is its own pull request. It merges before the plugin work starts, so no later commit carries a core diff.

---

## Task 2: Plugin skeleton, binary discovery, and registration

**Files:** `plugins/zcode-provider/paseo-plugin.json`, `index.server.ts`, `icon.svg`, `server/provider.ts`, `server/capabilities.ts`, `server/internal/binary.ts`, and the `builtinPlugins` list in `packages/server/src/server/plugins/builtin/index.ts`.

**Tests:** `plugins/zcode-provider/server/internal/binary.test.ts`.

**Design notes:**

- The capabilities live in their own module because the transport imports them and the transport is imported by the provider. Keeping them in `provider.ts` would make the two modules import each other.
- `@getpaseo/plugin/server` exports `PluginServerContext` as a type and `spawnProcess`, `execCommand`, `terminateProcess` and `defineAgentTool` as values. There is no `registerProvider` export; the registration happens through the server context the daemon hands the plugin. Every bundled plugin in `plugins/` uses this shape.
- The icon is a single-color, `currentColor` SVG with `viewBox="0 0 24 24"` and no external references.
- Adding the id to `builtinPlugins` is not a provider manifest entry, a provider factory, or a protocol-layer provider id. The daemon still learns about ZCode only through the plugin's own registration. `scripts/builtin-plugins-dist.test.mjs` iterates that list and asserts every listed plugin has a matching manifest, compiles, and starts, so the packaged build is covered by that test.

---

## Task 3: Tolerant frame decoding

ZCode's schemas are strict and keep gaining fields. A decoder that mirrors that strictness drops whole turns when ZCode adds one.

**Files:** `plugins/zcode-provider/server/internal/wire.ts`.

**Tests:** `plugins/zcode-provider/server/internal/wire.test.ts`.

The decoder lives in `wire.ts` and produces the frame union the RPC client and the transport both speak.

---

## Task 4: JSON-RPC client over a writable stream

**Files:** `plugins/zcode-provider/server/internal/rpc.ts`.

**Tests:** `plugins/zcode-provider/server/internal/rpc.test.ts`.

The client is written against a `write` seam, so the process layer overrides it with the child's stdout. It also answers reverse requests, because ZCode asks the host for permission with one.

---

## Task 5: Process lifecycle

**Files:** `plugins/zcode-provider/server/internal/process.ts` and `plugins/zcode-provider/test/fake-zcode-app-server.mjs`.

**Tests:** `plugins/zcode-provider/server/internal/process.test.ts`.

`spawnProcess` hands `options.env` to the child as-is; the child does not inherit `process.env`. A test that passes only `FAKE_ZCODE_MODE` gives the child an environment with nothing else in it. The real connection passes the daemon-owned launch environment, which is already complete.

---

## Task 6: Legacy transport and the event cursor

**Files:** `plugins/zcode-provider/server/internal/transport.ts` and `plugins/zcode-provider/server/internal/legacy-transport.ts`.

**Tests:** `plugins/zcode-provider/server/internal/legacy-transport.test.ts`.

**Design notes:**

- **Method-not-found downgrade.** ZCode's protocol answers a removed method with `-32601`. That is the only failure that may be downgraded: the capability goes away and the rest of the provider keeps working. Any other failure propagates. The transport keeps the unavailable set, and the connection drops the matching capability.
- The mapping from an unavailable method to a capability lives next to the transport, so the connection does not need to know the method names.

---

## Task 7: Turn state machine and the stop boundary

This task owns the rule that a cancel which has not settled blocks new runs.

**Files:** `plugins/zcode-provider/server/internal/session.ts`.

**Tests:** `plugins/zcode-provider/server/internal/session.test.ts`.

**Design notes:**

- Turns are tracked per input id, not in a single slot. A second prompt can be dispatched while the first turn is still running, and a single slot would attribute the first turn's completion to the second turn.
- ZCode stops the session's current turn, so the turn that started natively wins. A turn that was dispatched but never acknowledged by ZCode is still owed a terminal, so the most recently dispatched turn is the fallback.
- A terminal that arrives after a cancel is one the session already gave a terminal for, and a second terminal for a finished turn would flip it from cancelled to completed.

---

## Task 8: Timeline and permission mapping

**Files:** `plugins/zcode-provider/server/internal/timeline.ts` and `plugins/zcode-provider/server/internal/signals.ts`.

**Tests:** `plugins/zcode-provider/server/internal/timeline.test.ts` and `plugins/zcode-provider/server/internal/signals.test.ts`.

**Design notes:**

- ZCode's `tool.updated` payload is a discriminated union on `kind`, not a payload with a `status` field. The variants are `scheduled`, `started`, `progress`, `result`, `error`, `batch` and `raw`. Only `scheduled` carries the tool call's `input`, so the detail has to survive from that event to the later ones: the session keeps it per tool call id and passes it to the mapper.
- ZCode's `message.upserted` payload carries the content and nothing else: no message id and no role. The timeline id comes from the event, and a user message cannot be told apart from an assistant one there.
- The raw ZCode options travel in `metadata`, which is a `Record<string, JsonValue>` on the request. That keeps the SDK type intact and means the selected action's own `response` reaches ZCode unchanged, including any `permissionUpdates` that make "always allow" stick.
- The permission is not answered with a separate RPC. ZCode asks the host with a reverse request and waits for that request's own response. The transport therefore exposes the reverse request instead of an answering method.

---

## Task 9: Wire the provider connection

**Files:** `plugins/zcode-provider/server/provider.ts` and `plugins/zcode-provider/server/internal/catalog.ts`.

**Tests:** `plugins/zcode-provider/server/provider.test.ts` and `plugins/zcode-provider/server/internal/catalog.test.ts`.

**Design notes:**

- The connection follows the `plugins/antigravity-provider/server/provider.ts` shape: a session map, a listener set, a serialized send queue, and a `dispatch` switch over `ProviderInput`.
- ZCode projects its model, mode and thought-level options from session settings, and `session/read` requires a session id. The provider therefore opens a session for the request, reads the snapshot, and closes it again.
- ZCode's session info nests the workspace as `{ workspacePath, workspaceKey }` and reports `updatedAt` as a millisecond number, while Paseo's session summary wants a path and a string, so the summary converts both.
- Archive and unarchive are not session-scoped operations. The daemon restores an archived agent by calling `unarchiveNativeSession` _before_ it opens the session, so no live session exists at that moment. The connection drives the transport directly with the ZCode id carried by the persistence handle.
- The permission round trip belongs to the connection, not to the session. The `permission.requested` session event is the record of the same thing, and answering it does not release ZCode.
- **Process death.** `ZCodeProcess` exposes the failure through its `ready` promise, which rejects when the child exits. The connection awaits it once and reports the failure on every session the child hosted, or the daemon waits for a reply that never arrives.

---

## Task 10: End-to-end test against the fake app-server

**Files:** `plugins/zcode-provider/test/fake-zcode-app-server.mjs` and `plugins/zcode-provider/server/provider.test.ts`.

The provider test drives a real child process over the real protocol, so the fake app-server has to script a full turn: `session/create` returns a session id, `session/send` queues the events of the turn, and `session/events` returns the queued events the client has not seen yet, advancing by `seq`.

The fake app-server has to send the permission as a reverse request — a frame with an `id` and a `method` — and wait for that frame's answer. It is the answer to that request that releases ZCode, so the fake cannot move on until it receives one. The loop must not wait inside it: the answer arrives as a later line, and a loop that awaited would never read it. The fake therefore remembers the pending turn and finishes it when the answer comes.

The `timeline.item` event carries `item: ProviderTimelineItem`, and the assistant message comes from the `message.upserted` event the fake emits. The turn ends when `turn.completed` arrives, which the fake queues at the same `seq` order the transport reads.

---

## Deferred: the V4 transport

The V4 transport is a separate plan and is deliberately not part of this one. It needs a grounding pass over ZCode's V4 wire format that this plan did not do, and guessing at it would produce a plan full of invented detail.

Its entry criteria are met once this plan lands:

- The `ZCodeTransport` interface in `plugins/zcode-provider/server/internal/transport.ts` is the seam the V4 transport implements. It already exists, so the V4 work does not touch the legacy transport, the session state machine, the timeline mapper, the permission mapper, or the connection wiring.
- The capability list changes in exactly one place. `ZCODE_CAPABILITIES` in `plugins/zcode-provider/server/capabilities.ts` gains the rewind and steer capabilities, and the transport's own `capabilities` becomes the authority so the two transports differ without touching the connection.
- `PASEO_ZCODE_PROTOCOL` selects the transport. It reads `auto`, `legacy` or `v4` from the environment, with `auto` meaning "use the V4 transport when the CLI reports support for it, otherwise the legacy transport".

The V4 plan has to cover: topic subscription and the snapshot-plus-delta read model, the sequence and log-epoch watermarks, gap detection and resync, the CAS command envelope and its `baseRevision`, the six acknowledgement states, `applyFileRewind` and `editUserQuery` for rewind, the queue commands for steer, and the transport selection probe.

Its acceptance gate is the same as the spec states: `auto` resolves to V4 only after the V4 transport passes the real-ZCode local end-to-end smoke test. Until then `auto` resolves to legacy.
