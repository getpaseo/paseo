## Add a client slash command

A slash command runs plugin code in the app when the user submits `/name args`. Nothing is sent to the agent. `args` is the raw text after the command name, trimmed; parse it in the plugin.

```ts
client.addSlashCommand({
  name: "review",
  description: "Run the review bot",
  argumentHint: "[scope]",
  context: "agent", // or "workspace" so drafts get it too
  async onSubmit({ args, agent, rpc, openPanel }) {
    await rpc(startReview, { agentId: agent.id, scope: args });
    openPanel("review");
  },
});
```

The callback receives the same context as the matching Command Center item plus `args`. Paseo owns the autocomplete row, input clearing, and the error toast; put pending UI in a pill or panel. Precedence is built-in client commands, then plugin commands, then provider commands; a lower-precedence collision is dropped. Commands do not run while the composer has attachments. Server-side slash commands do not exist.
