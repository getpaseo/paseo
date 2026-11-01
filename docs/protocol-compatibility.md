# Protocol Compatibility

The app and the daemon are separate products that ship separately. A user updates the app from an app store or a desktop auto-update; they update the daemon when they feel like it. Every combination happens in the wild: new app against an old daemon, old app against a new daemon, and both sides months apart.

Development can have the same version drift: an app reload picks up new code while a long-running daemon keeps its loaded version. Check the connected daemon version when diagnosing behavior that crosses this boundary.

Two contracts follow from it.

## The protocol contract: always compatible

A schema change must not break parsing in either direction. An old app still parses messages from a new daemon. A new daemon still parses messages from an old app.

`hello` carries an optional credential. The daemon accepts a client protocol version from its minimum through newer client versions, selects the lower of client and daemon maximum, and reports it as optional `server_info.protocolVersion`. A `hello.rejected` frame precedes an auth close only when the client sent `hello.auth` or advertised `hello_rejection`; older clients receive the existing WebSocket close code and reason. This avoids sending them a new top-level message their validator does not recognize.

- New fields are `.optional()` with a sensible default.
- Never flip optional to required, remove a field, or narrow a type. `string` to `enum` and nullable to non-null are both narrowing.
- A field you stop sending stays accepted. You stop writing it, you don't stop reading it.
- Wire schemas are pure structural declarations. No `.transform()`, `.catch()`, or `.preprocess()` on WebSocket message schemas — normalization happens in an explicit pass after validation. The reason is in [protocol-validation.md](protocol-validation.md): inbound validators are generated, and the generator only compiles pure schemas.
- Plain `z.union()` is forbidden when every branch shares a literal tag. Use `z.discriminatedUnion()`.
- `.default()` belongs on primitive leaves only, never on item schemas inside large arrays or big inbound containers.

Two questions to ask before you commit a schema change:

1. Does a six-month-old app still parse this message?
2. Does a six-month-old daemon still send something this app accepts?

If you can't answer both with yes, the change isn't done.

Schemas live in `packages/protocol/src/messages.ts`. New RPC names follow [rpc-namespacing.md](rpc-namespacing.md).

## The feature contract: per feature, gated once

Features don't have to work across versions. A new feature usually needs a new daemon capability, and old daemons don't have it.

The app checks for the capability and either runs the feature or tells the user to update the host.

- **No fallback paths.** Don't build a degraded version of the feature for old daemons. Don't fan out across legacy RPCs to simulate a capability that isn't there. The user updates or doesn't get the feature.
- **No defensive branches spread through the feature.** Detection happens in one place, and everything downstream reads a clean shape.
- Capability flags live in `features` on the `server_info` message (`packages/protocol/src/messages.ts`, the `server_info` schema).

Existing functionality keeps working across versions. Never gate an established request on a new enhancement: negotiate the optional enhancement at the client boundary and preserve the existing request for older hosts. Whole-turn pagination can require a capability; reading conversation history cannot.

## Client capability ownership

The client package advertises the protocol behavior it implements. Add each new capability to
its exhaustive defaults and implement the associated subscription or decoding behavior there.
The app, CLI, and plugins inherit those defaults; they supply only host resources such as browser
automation, or explicit overrides. A schema accepting a message does not establish support for
its delivery semantics.

On capable daemons, connecting creates no timeline or event demand. Client subscriptions own their network membership,
release it on unsubscribe, and restore it after reconnect. Raw message observers inspect traffic
without requesting streams. Application caches and which agents are visible remain caller-owned.

## Terminal ANSI replay

Terminal replay intentionally drops JSON-era apps, an exception to the general cross-version policy:
use app v0.1.81 or newer. Earlier apps omit `restore` and reject ANSI Restore (`0x05`), so they show
only subsequent live output, without the existing screen or history.

`terminal_chunked_replay` is SDK-owned delivery behavior. The daemon sends new binary opcodes only to a source
advertising the capability. The SDK keeps the established subscribe request against older
ANSI hosts and normalizes their single Restore frame into begin/data/end. `observeTerminal` defaults
to an explicit full snapshot: omitting restore on an ANSI-era host selects its discarded JSON path.
Explicit caller restore modes and history counts pass through unchanged. JSON snapshot
wire declarations remain accepted, but JSON snapshot frames have no rendering runtime.
Terminals require `terminal-restore-modes`; older hosts show an update message without attaching.

## Binary chunking

`binary_chunking_v1` in hello and optional `server_info.features.binaryChunkingV1`
negotiate connection-scoped framing. Application serializers and routed envelopes use
the same boundary. Small messages and handshakes keep their existing representation.
Older peers retain existing frame limits.

The reserved binary opcode `0x31` is followed by version `1`, original kind
(`0` text, `1` binary), and START/END flag bits `0`/`1`. Remaining bytes are an
unchanged slice. There is no total length or chunk count; a future receiver can
consume slices incrementally. Today the receiver buffers up to the existing
100 MiB logical limit and decodes UTF-8 only after END. Transfers cannot interleave.
Disconnect clears partial state and negotiation.

The lower transport supplies its plaintext frame budget, including encryption
overhead. The sender waits for drain between chunks while ordinary messages keep
the existing delivery path. Slow-client protections count messages queued behind
an active transfer as well as bytes already in the socket.
The framing module never selects an encryption construction.

Native uploads retain the platform's existing queue limits. React Native's
WebSocket does not report its queued bytes, so the client cannot wait for native
drain. Android's installed OkHttp transport closes when a send would put more
than 16 MiB in its queue. The native transport disables outbound chunking, including
on routed channels, and retains its existing single-frame admission errors.
Inbound chunking remains enabled; daemon-to-native responses use the daemon's paced writes.

## Owned observations

`owned_subscriptions` and `server_info.features.ownedSubscriptions` negotiate the source-owned
contract described in [architecture](architecture.md#websocket-protocol). The client selects delivery
behavior once at its connection boundary. App workflows use the same observation interface on both.

With an older daemon, the client uses the existing connection and legacy RPCs. Directory subscriptions
remain shared and last-query-wins. Local handle IDs identify listeners; they do not promise independent
server filters. Timeline and event membership retain their existing shared behavior. Releasing a handle
detaches its listener and uses the old unsubscribe operation where one exists. Broadcast-only hosts keep
broadcasting; readiness there means local attachment, not a daemon acknowledgement. No extra sockets
or multiplexing emulation are introduced.

Preserve established workflows when changing delivery internals. Independent filters and quiet
connections require a capable daemon; opening the app, reading history and using terminals do not.
Pre-registry workspace grouping and legacy event normalization belong inside the client boundary.

Old clients keep their existing wire shapes and slot behavior at the daemon's source boundary.
The adapter keys legacy slots by physical socket, so an old connection cannot replace a modern
sibling's observation even when both use the same logical client ID. Optional wire IDs stay accepted
for parsing compatibility; modern requests cannot select their subscription ID.

Workspace setup details negotiate `workspace_setup_observation` with
`server_info.features.workspaceSetupObservation`. Capable clients cannot request details through
the legacy session event category. The setup panel owns a workspace-scoped observation while
active and visible; directory metadata signals failures without requesting output. Older clients
retain their legacy event delivery. A new app makes no setup event demand on older hosts and
requires a host update to view details. Subscription-capable older hosts honor that absence of
demand; broadcast-era hosts require an update before wire silence is guaranteed.

## Every shim is tagged and dated

A shim that exists for old-app or old-daemon support carries a comment naming it, the version it arrived in, and when it can go:

```ts
// COMPAT(workspaceFileEditing): added in v0.2.0, remove after 2027-01-18 once daemon floor >= v0.2.0.
```

`rg "COMPAT\("` is the full cleanup backlog, so:

- One tag per shim, at the site that has to be deleted.
- Give it a name, a version, and a removal condition or date. Six months out is the usual default.
- Never bury compatibility in an untagged `??` fallback or an optional-chain tunnel. Untagged back-compat never gets removed, because nobody can find it.

When a tag's condition is met, delete the shim and the tag in the same change.

## QA

Tests don't fully cover compatibility. If you touched `packages/protocol`, say in the pull request why an older app still parses your message and why an older daemon still satisfies your app. See [qa.md](qa.md).
