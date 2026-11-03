# Agent configuration

Sets saved Codex options through `server.addHook("agent.create.before", async ...)`:

- Sets `config.providerOptions.sandbox_mode` to `workspace-write`.
- Sets `config.providerOptions.approval_policy` to `on-request`.
- Preserves other configuration and provider options.

Adds the `company` MCP server to Codex launches through
`server.addHook("agent.open.before", async ...)`. The server is never saved in the agent's configuration;
existing saved MCP servers are preserved. Existing agents receive the server through the
[session reopen behavior](../../public-docs/plugins/hooks.md#attach-tools-to-agents).

Replace `https://tools.example.com/mcp` in `index.server.ts` with your MCP server URL before using
this example. A `company` name collision with a saved server or another
plugin fails the session open and names both sources.

Install on a daemon with plugins enabled:

```bash
paseo plugin install /absolute/path/to/plugin-examples/agent-configuration
```

Each session-open callback receives only this plugin's MCP servers. The nested spreads preserve
entries added by this plugin's earlier callbacks. The create callback receives configuration after
earlier plugins have transformed it; its explicit Codex options replace the named fields in the
saved configuration of new agents and remain after this plugin is disabled.

See [Inject MCP servers](../../public-docs/plugins/hooks.md#inject-mcp-servers) for choosing
between saved configuration and plugin-owned servers. [Lifecycle actions](../lifecycle-actions)
demonstrates provider switching and environment injection. Its provider-switch callback clears
provider options when changing Codex to Claude, so use these examples separately when trying the
Codex-specific settings.
