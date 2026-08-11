# Host-managed MCP servers

Configure an external MCP server once when every compatible agent on a host needs it. Use **Settings → Host → Agents → External MCP servers** to add, edit, disable, remove, and test saved servers.

Paseo supports its canonical `http`, `sse`, and `stdio` transports. HTTP and SSE headers and stdio environment variables accept either a direct private value or the name of an environment variable inherited by the daemon.

HTTP and SSE URLs cannot contain username/password credentials. Put authentication values in request headers so Paseo can redact them from configuration responses and connection-test failures.

Direct values are stored in `$PASEO_HOME/config.json`. Paseo keeps that file private, redacts direct values from daemon config responses, and does not copy host-managed definitions into agent records. Prefer environment references for deployments that already use a secret manager.

```json
{
  "daemon": {
    "mcp": {
      "servers": {
        "team-hub": {
          "type": "http",
          "url": "https://mcp.example.com/mcp",
          "headers": {
            "Authorization": {
              "source": "env",
              "name": "TEAM_MCP_TOKEN"
            }
          }
        }
      }
    }
  }
}
```

The daemon resolves environment references when an agent launches or when you test the saved server. A missing variable blocks that operation with the variable name in the error. Saving the definition remains allowed so deployment configuration can arrive separately.

Connection tests for `stdio` servers inherit only the MCP SDK safe environment defaults and the variables explicitly configured for that server. Other daemon environment variables are not passed to the test process, and test-process stderr is not written to daemon logs.

Enabled servers are injected only into providers that advertise MCP support. A server supplied by an individual agent/session overrides a host-managed server with the same name. Changes apply to new, resumed, or reloaded agents; Paseo does not restart active sessions.

Adding or testing a server uses the daemon host's network and, for `stdio`, can launch a local process. These operations are available only through an authorized daemon session and the test RPC accepts the name of an already-saved server rather than an arbitrary URL or command. Treat full daemon access as host-administrator access.

Host-managed servers are independent of provider profiles. Use [custom provider configuration](custom-providers.md#multiple-profiles-for-the-same-provider) when you need multiple Codex or Claude endpoints, credentials, or model sets.
