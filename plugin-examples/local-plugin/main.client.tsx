import { useMutation } from "@tanstack/react-query";
import { type PluginWorkspacePanelProps, useRpc, useWorkspace } from "@getpaseo/plugin";
import React, { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { incrementRpc } from "./increment.shared";

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
