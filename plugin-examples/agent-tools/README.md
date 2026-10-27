# Agent tools

Attaches `append_workspace_note` to agents whose `notes/enabled` label is `"true"`.
Calling the tool with `{ "note": "Run the targeted tests before committing." }` appends that
line to `AGENT_NOTES.md` in the calling agent's working directory and returns the file path.
It creates the file if it does not exist.

Install on a daemon with plugins enabled:

```bash
paseo plugin install /absolute/path/to/plugin-examples/agent-tools
```

Create a labeled agent through the SDK:

```ts
const agent = await paseo.agents.create({
  config: { provider: "codex/gpt-5.4" },
  cwd: "/projects/shop",
  labels: { "notes/enabled": "true" },
});
```

The session-open callback also runs when an agent resumes or reloads. After changing an existing
agent's labels, call `paseo.agents.ref(id).reload()` to apply the selection immediately. This
interrupts a running turn. `refresh()` reads the agent snapshot without reopening its session.

From the repository root, `npm run typecheck` includes this example. Outside this repository,
use `paseo plugin init` to create the package and TypeScript setup, then copy `index.server.ts`
and the manifest into that project.

See [Attach tools to agents](../../public-docs/plugins/reference.md#attach-tools-to-agents)
for targeting, execution, provider gates, collisions, and plugin reload behavior.
