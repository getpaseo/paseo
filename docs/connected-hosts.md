# Connected hosts

A saved host belongs to the daemon that stores it. The app's saved connections remain a separate list.
Connect A to B in A's settings under **Hosts connected to this daemon**, through `paseo --host A host`,
or through `paseo.hosts`. Consumers select B by its learned `serverId`; management uses the stable
`registrationId` created before B is reachable.

## Ownership and authority

Credentials live in A's `hosts.json`, written atomically with mode `0600`. Discovery returns a safe
target description. Replacement inputs never come back through a read API. Keep this file private
when collecting diagnostics or backing up daemon state.

The authenticated producer owns its source key. Repeating an unchanged add returns the saved entry,
including a user's disabled state. Changed input requires an explicit update. Display labels and
access can be changed by users with `tunnel.manage`; connection and metadata changes require the
producer or `access.manage`. Removing a producer-managed entry allows that producer to add it again.
Disabling retains the opt-out.

Each routed API owns a separate session. A derives its identity from the admitted origin session,
producer, and logical SDK scope. A replaces forwarded identity and grants, and B intersects those
grants with the authenticated link's authority. Reconnect reads current authority. Changing caller
permissions closes existing routes. A routed API cannot select a second hop.

A producer that registers a host through a routed API is qualified on B as
`route:<B principal>:<A serverId>:<A producer>`, with each component percent-encoded. This namespace belongs to the authenticated link
principal. An ordinary direct B consumer does not become that producer by supplying a source key.
The optional `server_info.sourceId` reports this producer identity for source-owner controls; it does not describe the authenticated admission principal.
Trusted server plugins retain the authority of their runtime; they are not sandboxed by this feature.

## Connections and recovery

The shared Node connector owns the target grammar and each connection attempt, including a fresh
SSH process. SSH reaches an already running daemon. The daemon keeps unreachable registrations and
retries them. Identity is pinned when discovered. Self and duplicate registrations remain inspectable;
a changed destination requires explicit identity replacement.

Both daemons must advertise `connectedHosts`. A checks B's capability and identity before forwarding
session operations. There is no local fallback. An older daemon continues to serve existing local
operations; requesting this feature gives update guidance.

Disposing a routed API releases its observations and session. It does not remove the saved host or
affect sibling API scopes. Disposing the origin cascades to its derived scopes. Observations restore
through the usual owned-subscription contract; requests made while offline fail. Losing a response
returns `outcome_unknown` with the destination ID. Inspect the destination before retrying a mutation.
No mutation is automatically replayed.

Host links cap saved registrations, simultaneous routes, frames, per-socket output, and shared queued
bytes. Slow consumers lose their route with a resource-limit error instead of retaining unbounded
output. Routed sessions release server resources on disconnect; subscription demand is rebuilt by
its owning client on reconnect.

See the [SDK reference](../public-docs/sdk/reference.md#clienthosts),
[CLI reference](../public-docs/cli.md#connected-hosts), and
[plugin reference](../public-docs/plugins/reference.md#connected-hosts).
