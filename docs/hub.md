# Paseo Hub relationship

Paseo Hub is an explicit opt-in connection from one Paseo daemon to one Hub. Running a daemon does
not register it with a Hub. The relationship begins only when a user runs
`paseo hub connect [url]` from the daemon machine with an explicit API key or matching stored CLI login.

The human CLI login and daemon relationship are separate identities. `paseo hub login [url]` stores a durable organization-scoped CLI credential keyed by normalized Hub origin under `PASEO_HOME`. Origin resolution uses explicit command input, `PASEO_HUB_URL`, active login, then `https://hub.paseo.sh`. Connect uses exact-origin authority to request a one-time enrollment token, then passes only that token to the daemon. The daemon generates and persists its own relationship credential.

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

Every Hub execution creates a fresh Paseo workspace. The workspace owns the execution's agents and
terminals. Local checkout and worktree targets select only the workspace backing and isolation; the
Hub cannot select or reuse an existing workspace. Hub creates use the same agent creation path as
trusted clients. They may select any worktree target shape and carry optional MCP server configuration and provider-native
`providerOptions` for the agent session. The daemon keeps that configuration in its private agent
record so provider sessions can recover after a restart; neither ordinary client snapshots and
updates nor Hub projections expose session configuration. See [providers.md](providers.md) for the
supported provider keys.

Hub tool preapproval is a private, structured list of `{ kind: "mcp", server, tool }` references.
Every reference must name an MCP server injected by the same create request. The daemon translates
only those identities into the selected provider's native approval configuration. The protocol
cannot name or preapprove native tools such as Bash, Edit, or Write. Explicit local or managed ask
and deny policy takes precedence. Providers without exact MCP preapproval support reject unattended
Hub creation instead of broadening access or waiting for an invisible prompt.
When a create request includes a tool policy, a successful response includes
`toolPolicyApplied: true`; absence of that acknowledgement is not success for unattended execution.

A Hub workflow may use read-only provider settings for classifier steps. This is defense in depth,
not a security boundary: classifier labels and prompt intent do not authorize tools. Exact MCP grants
and the provider's local or managed policy remain the authorization controls.

Execution completion policy remains outside the daemon: a completed agent turn does not imply that
the Hub execution is terminal.

The Hub ends an execution by sending `hub.execution.control.request` with the durable execution ID
and either `interrupt` or `archive`. The daemon resolves the agent from the authenticated daemon
relationship plus that execution ID; callers cannot supply an agent ID or workspace path. Both
actions are idempotent and continue to resolve from stored ownership after daemon restart.
If no execution exists for that authenticated daemon and execution ID, interrupt and archive return
success because the requested stopped or archived state already holds. An execution owned by another
daemon is indistinguishable from a missing execution and is never exposed or affected.

Interrupt uses the ordinary agent cancellation lifecycle. Archive resolves the execution agent's
required workspaceId and sends it through the shared workspace archive service. The service archives
that workspace's agents and terminals, then removes Paseo-owned backing directories only after their
final active workspace reference disappears. Local checkouts remain on disk; sibling workspaces
sharing a backing directory remain active.

## Disconnect and revocation

Normal socket loss reconnects the active relationship with bounded exponential backoff and jitter.
Daemon restart loads the same relationship and credential and reconnects without another enrollment
ceremony.

Hub authentication rejection or close code `4403` permanently revokes the local relationship. The
daemon deletes its credential, stops reconnecting, and retains only the relationship ID, Hub origin,
scopes, and a sanitized reason for status reporting.

`paseo hub disconnect` disables socket reconnect and execution authority before making one bounded
remote revocation request. The daemon then removes the local relationship whether the request
succeeds or fails. A failed request returns a warning that server-side revocation may remain pending.
`--force` skips the remote request. Legacy persisted `disconnecting` records are removed on startup;
the daemon does not retry revocation in the background.

`paseo hub logout` removes only the active human CLI credential and preserves credentials for other origins. Interactive logout inspects and optionally disconnects a same-origin daemon before deleting the login; a failed requested disconnect preserves the login. JSON and noninteractive logout never prompt or disconnect implicitly.

## Cross-repository compatibility

The consumer implementation lives in Paseo Cloud. Cloud owns its copy of the Hub wire schemas and
has no Paseo runtime or build dependency. Cross-repository end-to-end verification separately builds
a Paseo source checkout and exercises the real daemon, CLI, direct WebSocket, Cloud service, and
Postgres. That compatibility fixture is not a package dependency or fallback implementation.
Its `hub-e2e` ACP provider accepts only exact tool names on the injected `hub` MCP server. Other
custom ACP providers remain unsupported for unattended preapproval.
