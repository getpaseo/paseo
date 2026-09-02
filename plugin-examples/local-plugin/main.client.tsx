import { useMutation } from "@tanstack/react-query";
import {
  Icon,
  type PluginClientContext,
  type PluginComposerPillProps,
  type PluginWorkspacePanelProps,
  useAgent,
  useRpc,
  useWorkspace,
} from "@getpaseo/plugin";
import React, { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { incrementRpc } from "./increment.shared";

export function OpenCounterPill({ theme, workspaceId, agentId }: PluginComposerPillProps) {
  const workspace = useWorkspace(workspaceId, ({ name }) => ({ name }));
  const agent = useAgent(agentId, ({ title }) => ({ title }));
  const textStyle = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  return (
    <>
      <Icon name="Blocks" size={14} color={theme.colors.foregroundMuted} />
      <Text style={textStyle} numberOfLines={1}>
        {agent?.title ?? workspace?.name ?? "Counter"}
      </Text>
    </>
  );
}

export function contributeClient(client: PluginClientContext) {
  const pills = new Map<string, () => void>();
  let stopped = false;
  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (stopped || !agent.workspaceId) return;
    pills.get(agent.id)?.();
    const workspaceId = agent.workspaceId;
    const remove = client.addComposerPill({
      id: "open-counter",
      title: "Open plugin counter",
      workspaceId,
      agentId: agent.id,
      Component: OpenCounterPill,
      onPress() {
        client.openPanel("counter", { workspaceId });
      },
    });
    pills.set(agent.id, remove);
  };
  const remove = (agentId: string) => {
    pills.get(agentId)?.();
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
    for (const dispose of pills.values()) dispose();
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
