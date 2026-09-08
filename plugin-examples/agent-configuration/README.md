# Agent configuration

Changes new Codex agents through `server.before("agent.create", ...)`:

- Sets `config.providerOptions.sandbox_mode` to `workspace-write`.
- Sets `config.providerOptions.approval_policy` to `on-request`.
- Adds the `company` server to `config.mcpServers`.
- Preserves other configuration, provider options, MCP servers, and environment overrides.

Replace `https://tools.example.com/mcp` in `index.server.ts` with your MCP server URL before using
this example. The URL is a placeholder. The `company` entry replaces an existing server with that name.

Install on a daemon with plugins enabled:

```bash
paseo plugin install /absolute/path/to/plugin-examples/agent-configuration
```

The callback receives the request after earlier plugins have transformed it. The nested spreads
preserve their settings; the explicit values replace only the named fields. Paseo validates and saves
the resulting configuration before starting the agent. Existing agents are unchanged.

See the [lifecycle reference](../../public-docs/plugins/v0.8/reference.md#lifecycle-hooks) for ordering
and callback shapes. [Lifecycle actions](../lifecycle-actions) demonstrates provider switching and
environment injection. Its provider-switch callback clears provider options when changing Codex to
Claude, so use these examples separately when trying the Codex-specific settings.
