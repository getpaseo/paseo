import React, { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import {
  defineRpc,
  type PluginContext,
  type PluginWorkspacePanelProps,
  useWorkspace,
  useRpc,
} from "@paseo/plugin";

const incrementRpc = defineRpc({
  name: "increment",
  input: z.object({ value: z.number() }),
  output: z.object({ value: z.number(), handledBy: z.string() }),
});

const ExampleThemeSchema = z.object({
  colors: z.object({
    surface0: z.string(),
    foreground: z.string(),
    foregroundMuted: z.string(),
    accent: z.string(),
    accentForeground: z.string(),
    statusDanger: z.string(),
  }),
});

function ExamplePanel({ theme, workspaceId }: PluginWorkspacePanelProps) {
  const { colors } = ExampleThemeSchema.parse(theme);
  const workspace = useWorkspace(workspaceId, ({ name }) => ({ name }));
  const callIncrement = useRpc(incrementRpc);
  const { data, error, isPending, mutate } = useMutation({ mutationFn: callIncrement });
  const value = data?.value ?? 0;
  const styles = useMemo(
    () => ({
      screen: { flex: 1, padding: 24, gap: 16, backgroundColor: colors.surface0 },
      title: { color: colors.foreground, fontSize: 24 },
      detail: { color: colors.foregroundMuted },
      button: { padding: 14, borderRadius: 10, backgroundColor: colors.accent },
      buttonText: { color: colors.accentForeground, textAlign: "center" as const },
      error: { color: colors.statusDanger },
    }),
    [colors],
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

export default function contribute(plugin: PluginContext) {
  plugin.handle(incrementRpc, async (input) => ({
    value: input.value + 1,
    handledBy: "plugin subprocess",
  }));
  plugin.addWorkspacePanel({
    id: "counter",
    title: "Plugin counter",
    icon: "Blocks",
    context: "workspace",
    Component: ExamplePanel,
  });
  plugin.addCommandCenterItem({
    id: "open-counter",
    title: "Open plugin counter",
    icon: "Blocks",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("counter");
    },
  });
  return () => {};
}
