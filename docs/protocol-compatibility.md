# Protocol Compatibility

The app and the daemon are separate products that ship separately. A user updates the app from an app store or a desktop auto-update; they update the daemon when they feel like it. Every combination happens in the wild: new app against an old daemon, old app against a new daemon, and both sides months apart.

In development both sides are always the same version, which is why this is the constraint contributors miss most often.

Two contracts follow from it.

## The protocol contract: always compatible

A schema change must not break parsing in either direction. An old app still parses messages from a new daemon. A new daemon still parses messages from an old app.

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

Existing functionality keeps working across versions because of the protocol contract. Gating a new feature never substitutes for that.

Plugin tool IPC is a private daemon-to-child protocol, separate from the app WebSocket contract. A
plugin reports a bounded tool catalog only in its ready message, including installation identity and
generation. The host validates each invoke, update, result, cancellation, and error envelope. A
provider session captures the ready catalog; plugin reloads affect new sessions and immediately
reject calls against removed generations.

Caller-scoped plugin host IPC uses dotted request/response pairs under `plugin.host.*`. Every host
message carries request, invocation, generation, and installation identity. Schemas are strict and
the process boundary applies byte, depth, node, and dangerous-key limits to authority, options,
payloads, results, and errors. The process creates a new capability for each invocation; aborting
the invocation cancels pending host requests, and an unload rejects them. `plugin.rpc.invoke.request`
keeps the optional `callerAgentId` selector for newer app clients; the daemon resolves it against
live state and old peers continue to parse the request without that field. The
`pluginCallerHostApis` feature gate applies to app-selected caller scopes. A null or omitted
selector is a global RPC with null caller and null host.

Durable delivery payload compaction is negotiated through `server_info.features.deliveryPayloadTombstones`.
Only records admitted by a client advertising that capability may lose their acknowledged payload. A
capable client receives the retained tombstone and repeated acknowledgement is idempotent. A client
without the capability never receives a payloadless row; the daemon filters older clients from
already-compacted rows, and an acknowledgement of a known compacted delivery may return
`delivery_payload_unavailable` because that client's wire contract requires a payload. Delivery
request IDs remain wire-compatible strings bounded only by the complete accepted WebSocket frame,
including IDs longer than 256 bytes, while newly generated SDK IDs stay at the 256-byte application
limit. Correlated responses are sent to the originating socket; when the response or its bounded
error cannot fit, that socket is closed so the waiter rejects instead of losing the correlation.

Exact-turn cancellation is gated by `server_info.features.exactTurnCancellation`.
`agentTurnIdentity` only says that snapshots may identify the active turn; it does not
promise that cancellation is safe at the provider boundary.
Its `expectedTurnId` request field and response `status` are optional on the wire,
so older peers still parse the cancel messages. The public SDK does not fall back
to the stale unsafe operation: it requires the feature and rejects a response
that has no explicit cancellation status.

## Every shim is tagged and dated

A shim that exists for old-app or old-daemon support carries a comment naming it, the version it arrived in, and when it can go:

```ts
// COMPAT(workspaceFileEditing): added in v0.2.0, remove after 2027-01-18 once daemon floor >= v0.2.0.
```

`rg "COMPAT\("` is the full cleanup backlog, so:

- One tag per shim, at the site that has to be deleted.
- Give it a name, an added version, a concrete removal date, and actionable minimum client and daemon floors. Six months out is the usual default.
- Never bury compatibility in an untagged `??` fallback or an optional-chain tunnel. Untagged back-compat never gets removed, because nobody can find it.

When a tag's condition is met, delete the shim and the tag in the same change.

## QA

Tests don't fully cover compatibility. If you touched `packages/protocol`, say in the pull request why an older app still parses your message and why an older daemon still satisfies your app. See [qa.md](qa.md).
