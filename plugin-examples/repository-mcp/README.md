# Fictional repository MCP

This example chooses an existing HTTP MCP service. Plugins may instead register a stdio command or
legacy SSE endpoint; they need not implement every transport. The UI keeps its ordinary RPC. Both paths call the same fictional business function.

From a built Paseo checkout, run `node plugin-examples/repository-mcp/server/demo.mjs` to start the
fictional service on port 7779. Install this plugin directory, open its settings, and save
`http://127.0.0.1:7779/mcp` on that host. List repositories, show an empty list, trigger a business
error, then retry. The service returns only orchard and harbor; it has no real platform credentials.

A newly created Agent receives the same service definition through its provider's native MCP
configuration. The provider connects directly. The plugin UI uses ordinary RPC;
Paseo does not offer a host-side MCP client, Agent gateway or shared stdio process. Configuration updates affect
future runtime construction. Existing Agent connections may remain active until their runtime ends.

The server entry registers one service with `config: null`. Its existing settings subscription
calls `update({ type: "http", url })` when configured and `update(null)` when cleared. Cleanup
unsubscribes and calls `remove()`. No tool registration or Agent-facing RPC conversion is needed.
The MCP settings page links back to this plugin's configuration; Registered describes the definition,
not the connection state of an Agent.

To offer a local MCP executable instead, register a `stdio` config with `command`, optional `args`
and `env`. Resolve script/resource arguments against the readonly `server.directory`, because they
are not automatically rebased. A relative executable and explicit `cwd` resolve within that directory.
Only Codex currently supports an explicit per-service `cwd`; other providers report that limitation.
The child service needs its own executable/dependencies. An existing remote service can instead use
`http` or legacy `sse` with `url` and optional `headers`; actual transport support depends on the provider.
Plugins choose the transport they need, rather than implementing every option in this example UI.

If a platform only provides MCP, its plugin can use an MCP SDK in an ordinary RPC handler. That
client belongs to the plugin and must be closed during cleanup. Paseo supplies no common UI MCP
client, connection pool or provider proxy. This example shares a business function directly, so it
does not need that additional client. Keep service credentials in server-side configuration and out
of prompts, frontend payloads and logs; providers receive the private configuration they need.

The demo service is started separately so registration does not claim ownership of a remote server.
Stop it with Ctrl-C. Stopping/removing the plugin withdraws registration, not the HTTP service.

This API is unreleased. The checkout's beta version alone does not identify a published release
containing it; app, daemon and plugin SDK must all include this feature.
