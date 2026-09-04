# Providers

Paseo has one provider boundary. Core uses `ProviderRegistration` and `ProviderConnection` from
`@getpaseo/plugin/provider` for built-in and plugin providers. `runAcpProvider()` implements that
boundary; ACP is not a core interface.

## Connection contract

`ProviderRegistration.connect()` negotiates one protocol version and an intersection of flat,
dot-notated capabilities. The returned connection accepts JSON-safe inputs through `send()` and
publishes events through `onEvent()`.

Attach the listener before the first input. `send()` resolves after admission. Prompt, request, and
turn completion arrive as events. Never return a turn stream or async iterable from this boundary.

Connection capabilities are the provider-wide upper bound. Each `session.opened` event publishes
the subset supported by that session. Refuse an unnegotiated operation before sending it upstream.
Do not advertise `permission.tool_policy` unless the provider applies exact MCP grants fail-closed.

## Sessions and prompts

One connection owns every root and child session. Open a child with `session.opened` and
`parentSessionId`, then publish its lifecycle and timeline against its own session ID. Core stores it
as an ordinary child agent. There is no provider-subagent event vocabulary.

All user input uses `session.prompt`:

- `delivery: "auto"` may start a turn or complete a command side effect;
- `delivery: "steer"` targets active work and fails when steering is unsupported or no turn is
  active;
- `input.type: "command"` preserves the command name and arguments.

Every accepted prompt emits exactly one `session.prompt_result`. A live user timeline item carries
the submitted `clientMessageId` so the client can reconcile its optimistic row. Refused steering is
not retried as a new turn.

The complete session config crosses the boundary: cwd, environment, composed system prompt, MCP
servers, tool policy, model, mode, thinking option, settings, provider options, title, and
persistence intent. Paseo host tools are MCP servers; providers do not receive a second callback
tool API.

`settings` are provider-declared toggle/select values rendered by Paseo in the composer.
`providerOptions` is opaque JSON passed to the provider. A provider may translate either value
inside its implementation.

## Timeline and persistence

Providers publish complete Paseo timeline items with stable IDs. Reusing an ID replaces the current
item. Plugin items use the same timeline path and must name the plugin that registered the provider.

Persistence is versioned opaque JSON. Core stores the latest value and returns it in
`session.open`. Imports and unprimed sessions replay history as ordinary `timeline.item` events.

Reload uses `session.reload` on the existing connection and session ID. The provider prepares a
candidate without retiring the active runtime. Core quarantines candidate events until a matching
`session.ready(requestId)`, then commits the new config, capabilities, persistence, and history.
Failure discards candidate events and leaves the prior runtime and config usable. Events from the
retired runtime must stay suppressed.

Archive and unarchive are provider-wide actions gated by `session.archive` and
`session.unarchive`. Closing a session only releases its live runtime.

## Plugin providers

Register a direct implementation with `server.registerProvider()` from `index.server.ts`. The
[direct provider example](../plugin-examples/provider-direct/) demonstrates catalog discovery,
session listing and creation, prompts and commands, settings, persistence and replay, reload,
archive actions, and a child session with a plugin timeline item.

For a command-backed ACP, use `runAcpProvider()` from `@getpaseo/plugin/acp`. Its transformer hooks
are limited to discovery, configuration, vendor notifications, and merged tool-call snapshots. Do
not add a generic provider-event transformer. Official ACP SDK types stay inside the adapter.

The [ACP transformer example](../plugin-examples/provider-acp-transformer/) normalizes a concrete
vendor-shaped file-edit payload before it becomes a Paseo tool-call item.

## Built-in edge

Built-in SDK and command implementations remain private to `agent/providers/`. The provider
registry wraps each implementation with `registerNativeProvider()` and exposes only a
`ProviderRegistration` to the rest of the daemon. Native history iteration, returned SDK values,
provider-specific commands, and child notifications are translated inside that edge adapter.

New provider integrations should implement the public boundary directly. Changes to a private
built-in implementation must keep its translation inside the native registration module.

## Provider helper processes

Provider-owned helper processes that can outlive an individual agent session must be recorded in
the daemon's managed-process registry. Store provider/kind metadata, the PID, launch command/args,
and process identity captured from the platform process table. Remove the record on normal exit or
shutdown.

If a helper process has a readiness phase, the provider's lifecycle model must own the process
immediately after `spawn`, before readiness succeeds. Startup timeout, startup exit, and daemon
shutdown must all clean up through that owned generation. Do not keep a spawned helper only inside
a readiness promise; that creates a live process outside the manager/reaper contract.

Daemon bootstrap reconciles that ledger in the background, without blocking startup: dead PIDs are
deleted, PID identity mismatches are deleted without killing anything, only positively matched
Paseo-owned leftovers are terminated, and a record whose process cannot be inspected is left in
place for the next reconcile rather than deleted. Do not add broad process-name sweepers for
provider cleanup; cleanup starts from records Paseo previously wrote.

## Provider snapshot refresh contract

The daemon keeps provider snapshots per resolved working directory, with a separate semantic global
scope for settings/provider management and requests that do not carry a cwd. Boundary catalog
requests carry the resolved cwd for workspace scope and omit it for global scope. Providers decide
what global means for their runtime; do not infer global by comparing a cwd to the user's home
directory.

`ProviderSnapshotManager` owns one refresh deadline per provider. The deadline starts before the
availability check and covers that check plus the complete catalog probe. Providers that make
multiple catalog requests must not apply this deadline separately to each request. The manager
aborts the shared refresh signal at the deadline. Providers name active catalog operations and
finish subprocess, server, or session cleanup before rejecting. Timeout errors list the operations
that were still active when the deadline expired.

Snapshot reads may probe providers only while the requested cwd scope is cold. Once an entry is
warm, its `ready`, `error`, or `unavailable` state stays cached until an explicit refresh. Do not add
TTL revalidation, focus-triggered refreshes, selector-open refreshes, or config-reload refreshes.
Selector-open refetches may read an already-loading or stale React Query, but they must not force
provider probing on their own.

Capable clients receive a compact, content-addressed snapshot. Model rows derive their provider from
the containing entry and reference snapshot-level thinking sets. The app persists that compact
shape per server and cwd, then sends its hash on the next pull; an unchanged response carries no
catalog body. Keep the legacy encoding for clients without the capability. The hash covers the
complete client-visible compact snapshot, including status and `fetchedAt`, so explicit refreshes
invalidate it even when the discovered catalog is otherwise equal.

Settings refresh is the user-facing "forget stale provider knowledge everywhere" action. A settings
refresh clears provider snapshot caches and in-flight loads across all cwd scopes, then immediately
refreshes only the global snapshot with `force: true`. Workspace snapshots are re-probed lazily on
the next scoped read; do not fan out a settings refresh across every known workspace.

Registry/config replacement may update visible metadata such as label, description, default mode,
enabled state, and provider membership, but it must not spawn provider processes. If a provider
needs to be re-probed after a config change, route that through the explicit settings refresh path.

Boundary tests should assert observable behavior: cold reads may call provider availability and
catalog discovery for that scope; warm reads and registry replacement must not; explicit workspace
refreshes affect only one cwd; settings refresh wipes all scopes but immediately refreshes only
global.

## Provider usage fetchers

Provider plan usage is fetch-on-demand, not a daemon push subscription. The app calls
`provider.usage.list.request` through React Query when the usage tooltip or Host Usage settings
screen is shown, and the daemon returns the normalized `ProviderUsage` list directly.

To add plan usage for a provider, add
`packages/server/src/services/quota-fetcher/providers/<provider>.ts` and register it in
`packages/server/src/services/quota-fetcher/manifest.ts`. The provider file exports only its fetcher
class; provider auth, endpoint constants, API schemas, and normalization helpers stay private in
that file. A fetcher owns provider auth/API parsing and returns the generic shape:

- `providerId`, `displayName`, `status`, and optional `planLabel`
- any number of `windows` such as Session, Weekly, or Biweekly
- optional `balances` for credits, USD, requests, or tokens
- optional `details` for provider-specific rows

Keep the protocol shape provider-agnostic. Do not add provider-specific renderers for new limit
windows; labels and generic bars should carry the UI. API responses should be parsed and normalized
with Zod inside the fetcher, while the protocol boundary stays strict so old/new client
compatibility is explicit.

Kimi Code usage follows the CLI-managed credential file at `KIMI_CODE_HOME` or
`~/.kimi-code/credentials/kimi-code.json`; do not probe the legacy `~/.kimi` path as the primary
source for current Kimi Code installs.

Cursor usage reads the desktop `state.vscdb` token first, then `cursor-agent`'s
`~/.config/cursor/auth.json`. Headless hosts only have the CLI file.

### Usage fetchers are read-only on credentials

A fetcher reads the provider's credential file and never writes it. On a 401 or 403 it returns
`unavailable` and leaves refresh to the provider's own CLI: redeeming a refresh token in the fetcher
invalidates the CLI's copy (refresh tokens are single-use), and rewriting the file through the
fetcher's Zod schema drops any field the schema does not model, corrupting the file for the CLI.

## Testing

Test boundary behavior with real in-process connections or subprocesses. Cover admission separately
from completion, capability refusal before upstream I/O, prompt disposition and reconciliation,
atomic configure, reload commit and failure preservation, retired-event suppression, malformed IPC,
and process loss. Run only the targeted test file while iterating; see [testing.md](testing.md).
