import React, { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import { defineRpc, type PluginContext, useRpc } from "@paseo/plugin";

const incrementRpc = defineRpc({
  name: "increment",
  input: z.object({ value: z.number() }),
  output: z.object({ value: z.number(), handledBy: z.string() }),
});

interface ExampleTheme {
  colors: {
    surface0: string;
    foreground: string;
    foregroundMuted: string;
    accent: string;
    accentForeground: string;
    statusDanger: string;
  };
}

function ExampleSurface({ theme }: { theme: ExampleTheme }) {
  const callIncrement = useRpc(incrementRpc);
  const { data, error, isPending, mutate } = useMutation({ mutationFn: callIncrement });
  const value = data?.value ?? 0;
  const styles = useMemo(
    () => ({
      screen: { flex: 1, padding: 24, gap: 16, backgroundColor: theme.colors.surface0 },
      title: { color: theme.colors.foreground, fontSize: 24 },
      detail: { color: theme.colors.foregroundMuted },
      button: { padding: 14, borderRadius: 10, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground, textAlign: "center" },
      error: { color: theme.colors.statusDanger },
    }),
    [theme.colors],
  );
  const handleIncrement = useCallback(() => {
    mutate({ value });
  }, [mutate, value]);

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Native plugin surface</Text>
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
  plugin.addSurface("main", ExampleSurface);
  plugin.addSidebarItem({
    id: "main",
    title: "Local plugin",
    icon: "Blocks",
    surface: "main",
  });
}
