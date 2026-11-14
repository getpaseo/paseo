## Add a composer pill

A pill is a per-agent button in the composer track bar next to Tasks and Subagents. Add and remove pills from the client entry lifecycle. `addComposerPill` exists on `PluginClientContext`.

```tsx
import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

export function contributeClient(client: PluginClientContext) {
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();
  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    pills.get(agentId)?.remove();
    pills.set(
      agentId,
      client.addComposerPill({
        id: "review",
        workspaceId,
        agentId,
        button: {
          title: "Open review",
          icon: "Scan",
          label: "Review",
          behavior: {
            kind: "action",
            onPress() {
              client.openPanel("review", { workspaceId, agentId });
            },
          },
        },
      }),
    );
  };
  const removeAll = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
  // An owned list subscription delivers existing agents, then updates, and a fresh snapshot after a reconnect.
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") return register(update.agent);
          pills.get(update.agentId)?.remove();
          pills.delete(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("Agent observation failed", error);
    });
  return () => {
    lifetime.abort();
    removeAll();
  };
}
```

Call `contributeClient(client)` from `index.client.tsx`, or move its body into that entry. The `button` descriptor sets the icon, label, and behavior; Paseo owns the pressable, chrome, pending state, error reporting, and placement. `addComposerPill` returns a registration with `update()` and `remove()`. `remove()` is idempotent, and Paseo removes every pill when the plugin, client entrypoint, or host connection is torn down.
