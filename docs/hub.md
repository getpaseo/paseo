# Paseo Hub relationship

Paseo Hub is an explicit opt-in connection from one Paseo daemon to one Hub. Running a daemon does
not register it with a Hub. The relationship begins only when a user runs
`paseo hub connect [url]` from the daemon machine with an explicit API key or matching stored CLI login.

The human CLI login and daemon relationship are separate identities. `paseo hub login [url]` stores a durable organization-scoped CLI credential keyed by normalized Hub origin under `PASEO_HOME`. Interactive login optionally connects the local daemon, then points to the Hub UI for trigger configuration; it does not scaffold or deploy configuration. `paseo hub init` remains the explicit triggers-as-code scaffold: it writes one self-contained organization trigger under `.paseo/triggers/`, validates it through the trigger API, and optionally installs it. `paseo hub deploy` validates and installs every trigger in that directory; passing `--project` keeps deploying the legacy project bundle instead. `paseo hub export [directory]` writes the active organization's current triggers in the same layout, using the active login unless another Hub or API key is selected. Origin resolution uses explicit command input, `PASEO_HUB_URL`, active login, then `https://hub.paseo.sh`. Connect uses exact-origin authority to request a one-time enrollment token, then passes only that token to the daemon. The daemon generates and persists its own relationship credential.

## Connection and authority

The daemon enrolls over HTTP(S), then opens and maintains a direct outbound WebSocket to the Hub.
The Hub never discovers or acquires the daemon through Paseo's relay. The relay remains an optional
encrypted path for normal Paseo clients and has no role in Hub enrollment, authentication, dispatch,
or reconnects.

The daemon persists a relationship ID and private connection credential before enrollment. The
relationship is independent of its current transport, so a future transport can replace the direct
WebSocket without pairing again. The current foundation supports one Hub relationship per daemon.

Normal authenticated daemon sessions may manage the daemon's Hub relationship and permissions.
Hub connections have no daemon permissions by default. Connecting gives Hub machine identity and
presence but no execution authority. The `hub.execute` permission lets workflows triggered from
GitHub, Slack, Discord, Linear, and other integrations create workspaces and run agents. Grant it
during interactive login or later with `paseo hub permissions grant hub.execute`. Relationships
created before this split migrate their legacy execution scope to `hub.execute`. Hub sessions cannot
manage their own relationship or permissions.

## Session grants and agent operations

Hub uses the same authenticated, resumable Session protocol as other clients. Its persisted
`hub.execute` permission authorizes ordinary agent creation, messaging, cancellation, archival,
agent/workspace observation, timeline subscriptions, and workspace recovery. This authority is
daemon-wide; it is not limited to agents created by that Hub. Daemon configuration, terminals,
browser control, and permission management still require their own permissions. See
[permissions.md](permissions.md).

Clients using this contract check `server_info.features.hubAgentRpc` and
`server_info.features.agentRequestReceipts` once. An older host must be upgraded; do not silently
fall back to creating a fresh agent when continuation was requested.

Hub owns conversation keys, trigger policy, execution records, and the mapping to workspace/agent
IDs. None of these routing concepts are part of the generic daemon RPCs. Creation accepts ordinary
provider configuration, exact MCP tool policy, environment, and workspace/worktree selection.
Private session configuration is persisted for recovery and is not exposed in agent snapshots.
Provider controls remain provider-native; see [providers.md](providers.md).

`create_agent_request.idempotencyKey` identifies one creation operation. With a key, omit
`initialPrompt`, persist the returned agent/workspace identity, then deliver the prompt using
`send_agent_message_request` with a stable `messageId`. Request IDs correlate individual attempts;
creation keys and message IDs identify the operation across attempts. A creation key is daemon-wide;
a message ID is scoped to its agent. Reusing either with different arguments is a conflict.

The daemon journals the assigned agent ID before creation. Concurrent retries share one operation,
and a retry after a lost acknowledgement or restart returns the durable agent without creating a
workspace or starting a turn. Deleting that agent does not make its old creation key reusable.
Confirmed message delivery is also journaled, so retrying its message ID does not submit it again.
An unfinished delivery after restart reports `agent_request_outcome_unknown`: a provider can have
accepted a prompt before the daemon recorded success, so automatic resubmission could duplicate
work. Inspect the agent before choosing a new message ID. Receipts contain identity and request
hashes, never prompts, environment values, or credentials.

Before messaging an archived workspace, call `workspace.recovery.inspect.request`, then
`workspace.recovery.restore.request` and await success. The native message handler unarchives the
agent and loads its persisted provider session. `activeTurnBehavior: "steer"` uses the provider's
native steering behavior, including Paseo's existing behavior when that provider cannot steer.
Execution completion and arrival-specific output authority remain Hub responsibilities.

The older `hub.execution.*` RPCs remain accepted for existing clients. Their execution ownership
and create deduplication behavior are unchanged; new continuation work uses the ordinary RPCs.

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
