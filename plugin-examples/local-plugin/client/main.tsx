import { useMutation } from "@tanstack/react-query";
import {
  type PluginClientContext,
  type PluginButtonRegistration,
  type PluginWorkspacePanelProps,
  useRpc,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { incrementRpc } from "../shared/increment";

export function contributeClient(client: PluginClientContext) {
  const pills = new Map<string, PluginButtonRegistration>();
  let stopped = false;
  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (stopped || !agent.workspaceId) return;
    pills.get(agent.id)?.remove();
    const workspaceId = agent.workspaceId;
    const remove = client.addComposerPill({
      id: "open-counter",
      workspaceId,
      agentId: agent.id,
      button: {
        title: "Open plugin counter",
        icon: "Blocks",
        label: "Counter",
        behavior: {
          kind: "action",
          onPress() {
            client.openPanel("counter", { workspaceId });
          },
        },
      },
    });
    pills.set(agent.id, remove);
  };
  const remove = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };
  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") remove(update.agentId);
    else register(update.agent);
  });
  void client.paseo.agents
    .list()
    .then(({ entries }) => {
      for (const { agent } of entries) register(agent);
      return undefined;
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    unsubscribe();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}

export function ExamplePanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, ({ name }) => ({ name }));
  const callIncrement = useRpc(incrementRpc);
  const { data, error, isPending, mutate } = useMutation({ mutationFn: callIncrement });
  const value = data?.value ?? 0;
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        gap: 16,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24 },
      detail: { color: theme.colors.foregroundMuted },
      button: { padding: 14, borderRadius: 10, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground, textAlign: "center" as const },
      error: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );
  const handleIncrement = useCallback(() => {
    mutate({ value });
  }, [mutate, value]);

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Workspace plugin panel</Text>
      <Text style={styles.detail}>{workspace?.name}</Text>
      <Text style={styles.detail}>{data?.handledBy ?? "The RPC has not run yet."}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Increment plugin counter, currently ${value}`}
        onPress={handleIncrement}
        style={styles.button}
      >
        <Text style={styles.buttonText}>
          {isPending ? "Calling daemon…" : `RPC counter: ${value}`}
        </Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error.message}</Text> : null}
    </View>
  );
}
