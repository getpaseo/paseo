# Lifecycle actions

Small callbacks using the existing SDK:

- Send `Try again.` when the latest output contains `out of credits`.
- Decline a shell request matching `rm -rf`; approve exactly `git status`; leave other requests alone.
- Inject `PASEO_HOOK_CREATE_EXAMPLE=created` on creation and `PASEO_HOOK_OPEN_EXAMPLE=opened` on each session opening.
- Change requested Codex agents to Claude Haiku before creation.
- Create a worktree when a directory creation request is titled `Isolated lifecycle example`.

This is a demonstration plugin: installing it enables all these behaviors on its host. Install it
alongside `lifecycle-logger` on a test daemon with plugins enabled:

```bash
paseo plugin install /absolute/path/to/plugin-examples/lifecycle-actions
paseo plugin install /absolute/path/to/plugin-examples/lifecycle-logger
paseo plugin logs lifecycle-logger
```

Copy the callbacks you need into your own plugin. The follow-up example sends a new message; it does
not replay attachments or undo previous tool effects. If the provider keeps returning the matching
phrase, it keeps sending follow-ups. Add limits or delay in your plugin when your workflow needs them.
The command regex illustrates a policy; it does not parse shell syntax or cover every deletion command.

`server/inspect.ts` joins provider text chunks and excludes earlier turns and the current user prompt
from the phrase match. The failing-first regression test records the split text observed with a real
Claude agent.

See [agent configuration](../agent-configuration) for a focused example that injects MCP servers and
changes Codex sandbox and approval options while preserving other settings.

See the [lifecycle reference](../../public-docs/plugins/v0.8/reference.md#lifecycle-hooks) for the API.
