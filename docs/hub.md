# Paseo Hub relationship

Paseo Hub is an explicit opt-in connection from one Paseo daemon to one Hub. Running a daemon does
not register it with a Hub. The relationship begins only when a user runs
`paseo hub connect <url> --token <token>` from the daemon machine.

## Connection and authority

The daemon enrolls over HTTP(S), then opens and maintains a direct outbound WebSocket to the Hub.
The Hub never discovers or acquires the daemon through Paseo's relay. The relay remains an optional
encrypted path for normal Paseo clients and has no role in Hub enrollment, authentication, dispatch,
or reconnects.

The daemon persists a relationship ID and private connection credential before enrollment. The
relationship is independent of its current transport, so a future transport can replace the direct
WebSocket without pairing again. The current foundation supports one Hub relationship per daemon.

Normal authenticated daemon sessions may run the `hub.management.daemon.connect`,
`hub.management.daemon.get_status`, and `hub.management.daemon.disconnect` RPCs. Hub connections
receive only `hub.execution.*` authority, so execution credentials cannot manage the relationship.

## Session grants and execution ownership

Trusted clients and the Hub use the same `Session` implementation. The connection boundary supplies
grants: trusted clients receive `*`, while an enrolled Hub connection receives its persisted
`hub.execution.*` grant. One matcher handles exact RPC names and trailing namespace wildcards for
both inbound requests and outbound messages. A denied request returns the ordinary `rpc_error`
shape.

The Hub connection still has a narrow lifecycle boundary: it has no trusted-client hello/resume,
browser, binary, retained-session, or broadcast state. Its outbound execution events include only
agents owned by that daemon identity, so unrelated local agents remain outside the Hub surface.

Each Hub create carries an execution ID. The daemon stores that ID with the agent's relationship
owner before acknowledging creation. Duplicate or replayed creates for the same daemon and
execution resolve to the same durable agent. After a lost response, reconnect, or daemon restart,
the Hub retries `hub.execution.agent.create.request` with the same execution ID. The idempotent
response returns the existing agent and its current state; there is no separate reconciliation RPC.
Transient stream frames are not durably replayed.

Daemon restart preserves the Hub relationship and owned execution identity, but interrupts any
active turn. The daemon persists that agent as `closed`; an idempotent create retry returns the same
daemon, execution, and agent identity with that terminal state. Paseo never stores or automatically
replays the original prompt. A duplicate create returns the existing agent without starting another
turn.

Hub creates use the same agent creation path as trusted clients. They may select any existing
worktree target shape and may request `autoArchive`. Worktree creation and terminal auto-archive use
the shared workspace-aware lifecycle policy; Hub does not have a second launch or cleanup path.

## Disconnect and revocation

Normal socket loss reconnects the active relationship with bounded exponential backoff and jitter.
Daemon restart loads the same relationship and credential and reconnects without another enrollment
ceremony.

Hub authentication rejection or close code `4403` permanently revokes the local relationship. The
daemon deletes its credential, stops reconnecting, and retains only the relationship ID, Hub origin,
scopes, and a sanitized reason for status reporting.

`paseo hub disconnect` disables socket reconnect before requesting remote revocation. If the Hub is
offline, the daemon persists `disconnecting` and retries revocation across daemon restarts without
opening a Hub socket. This also covers an enrollment whose request may have succeeded but whose
response was lost. `--force` removes local authority immediately and warns that remote revocation may
still be pending.

## Cross-repository compatibility

The consumer implementation lives in Paseo Cloud. Cloud owns its copy of the Hub wire schemas and
has no Paseo runtime or build dependency. Cross-repository end-to-end verification separately builds
a Paseo source checkout and exercises the real daemon, CLI, direct WebSocket, Cloud service, and
Postgres. That compatibility fixture is not a package dependency or fallback implementation.
