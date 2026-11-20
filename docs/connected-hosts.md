# Connected hosts

A saved host belongs to the daemon that stores it. The app's saved connections remain a separate list.
Connect A to B through `paseo --host A host` or `paseo.hosts`. Consumers select B by its learned `serverId`; management uses the stable
`registrationId` created before B is reachable.

## Ownership and authority

Credentials live in A's `hosts.json`, written atomically with mode `0600` on POSIX systems. Discovery returns a safe
target description. Replacement inputs never come back through a read API. Keep this file private
when collecting diagnostics or backing up daemon state.

The authenticated producer owns its source key. Repeating an unchanged add returns the saved entry,
including a user's disabled state. Changed input requires an explicit update. Display labels and
access can be changed by users with `tunnel.manage`; connection and metadata changes require the
producer or `access.manage`. Removing a producer-managed entry allows that producer to add it again.
Disabling retains the opt-out.

Each enabled registration owns one physical daemon link, shared by status monitoring and every
routed API scope. Each scope owns an isolated virtual session on B. A derives its identity from the
admitted origin session, producer, and logical SDK scope. B admits virtual sessions under the actual
physical link principal, then intersects forwarded caller grants with that link's current authority.
Changing or resuming a parent's grants closes its existing channels; reconnect re-admits demand with
current authority. A routed API cannot select a second hop, and saving a host grants no reverse access.

A producer that registers a host through a routed API is qualified on B as
`route:<B principal>:<A serverId>:<A producer>`, with each component percent-encoded. This namespace belongs to the authenticated link
principal. An ordinary direct B consumer does not become that producer by supplying a source key.
The optional `server_info.sourceId` reports this producer identity separately from the authenticated admission principal.
Trusted server plugins retain the authority of their runtime; they are not sandboxed by this feature.

## Delegating agents

Agent MCP discovers destination IDs with `list_hosts`. `create_workspace`, `list_workspaces`,
`create_agent`, `send_agent_prompt`, `get_agent_status`, `get_agent_activity`, and `list_agents`
accept `serverId`; omission selects the calling daemon. Remote creation requires a
destination workspace and explicit provider/model. Caller filesystem defaults apply only on the
calling daemon. Prompting a remote child acknowledges acceptance and uses the existing idle wait for
finish notifications. Remote agent lists have no caller-directory default; pass `cwd` to filter them.

The parent’s Subagents track shows qualified children across connected hosts. Opening a child uses
the ordinary conversation on the destination's session. The runtime selects among that host's
connection candidates, including direct connections and routes discovered through another daemon.
Adding a direct connection to a discovered host adds another candidate. If no candidate connects,
the destination workspace keeps its existing disconnected or reconnecting behavior.

Finish notifications name the destination server and child agent. The caller's daemon owns durable
subscription intent and restores observation through the same routed wait and permission observation
used during ordinary operation. Restarting the caller's daemon does not imply that a remote child
stopped. Three failed remote observation attempts end the subscription with a notification that the
child could not be observed and its status is unknown. This does not prove the host is offline: remote
RPC failures also prevent observation. Attempts use capped backoff; a connection still
in progress does not spend that budget. A confirmed removed registration reports host unavailability
immediately through the same path. Neither notice claims the child finished. Intent remains stored
until the parent accepts dispatch, then is consumed; reconnecting does not restore that watch. The
parent decides whether to inspect the child or delegate again.

A definitely unsent prompt returns a tool error and creates no notification. An ambiguous prompt
response retains intent because the destination may have admitted it; observation then follows the
same retry policy. A confirmed missing child reports unavailability.

Remote creation and local subscription persistence are separate commits. A failed local write reports
failure even if the destination already created the child; inspect it before retrying creation.
See [finish notification lifetime](agent-lifecycle.md#relationships) for registration, acknowledgment,
and duplicate-delivery semantics. Concurrent prompts gain no turn attribution.

## Allow instructions from another host

On the receiving host, open **Settings → Hosts → [host] → Connections → Allow instructions from another host**.
Choose a connected sending host and an existing workspace conversation. **Ask each time** holds the
prompt for approval on this page. **Allow unattended** queues it as soon as it arrives. Both daemons
need a build with host instructions, and the receiving host must have relay enabled.

Ask an agent on the sending host to use `list_instruction_targets` and `send_host_instruction`.
Use the receipt with `get_host_instruction_status` or `cancel_host_instruction`. The sending daemon
retries delivery when the receiver wakes. The receiving daemon waits for a busy conversation to finish
its current turn. The receiving agent can use `reply_host_instruction` to return an explicit reply.

The destination owns the grant and can revoke it while the source is offline. The instruction relay
uses its own endpoint identity and accepts only instruction traffic. The workspace conversation
grant applies to anyone who can direct agents on the sending daemon. Review any ordinary connected-host
registrations separately if the machines also use general host routing.

## Connections and recovery

The shared Node connector owns the target grammar and each connection attempt, including a fresh
SSH process. SSH reaches an already running daemon. The shared client connection lifecycle owns
physical reconnect and keepalive; the registry retains configuration, identity acceptance, and recovery
status. Unreachable registrations remain saved. Identity is pinned when discovered. Self and duplicate
registrations remain inspectable; a changed destination requires explicit identity replacement.

Both daemons advertise `connectedHosts`; the shared link additionally requires `hostMultiplexing`.
A completes capability and pinned-identity checks on each physical recovery before admitting channels. There is no local fallback. An older daemon continues to serve existing local
operations; requesting this feature gives update guidance. The registry retries an older destination
with capped backoff, so it comes online once updated. Self, duplicate, changed-identity, and
authentication failures stay in `error` until an update changes the connection, `enabled`, or
`replaceIdentity`, or A restarts.

Disposing a routed API releases its observations and session. It does not remove the saved host or
affect sibling API scopes. Disposing the origin cascades to its derived scopes. Observations restore
through the usual owned-subscription contract. The ordinary client queues new requests while connecting
within its existing deadline and rejects requests while disconnected. Connection loss clears old
waiters and queued sends. Submitted requests with no response fail with `DaemonConnectionError`
(`DAEMON_CONNECTION_LOST`), optional `outcome: "unknown"` and known `serverId`. Inspect the destination
before retrying a mutation.
Ordinary non-recoverable mutations are not automatically replayed. Existing acknowledged/idempotent
creation recovery retains its request identity and resumes through the ordinary creation lifecycle. Multiplexing changes only the transport: ordinary permission
RPC codes pass through unchanged, and connection/recovery behavior matches direct clients.

Text session envelopes carry a channel identifier. Binary routing adds an opcode, a bounded UTF-8
channel identifier, and the original terminal or file-transfer bytes. It never converts those bytes to
base64 JSON. The existing direct binary opcodes and 100 MiB message limit remain unchanged; routed
payloads reserve space for the routing header inside that limit. Relay encryption retains its own
existing frame limit.

Host links cap saved registrations, simultaneous channels, handshake lifetime, frames, physical
output, and aggregate queued bytes. Capacity checks use the actual escaped outer JSON or binary
frame size. Awaitable output completes when the physical send completes. An overflowing channel
closes without closing siblings or the saved link. Routed sessions release resources on disconnect;
subscription demand is rebuilt by its owning client on reconnect.

See the [SDK reference](../public-docs/sdk/reference.md#clienthosts),
[CLI reference](../public-docs/cli.md#connected-hosts), and
[plugin reference](../public-docs/plugins/reference.md#connected-hosts).
