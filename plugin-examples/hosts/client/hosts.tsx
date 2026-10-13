import {
  getPaseoClient,
  useHosts,
  usePaseo,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

export function Hosts({ theme }: PluginSurfaceProps) {
  const hosts = useHosts();
  const selected = usePaseo();
  const [result, setResult] = useState("");
  const list = useCallback(
    async (serverId?: string) => {
      try {
        const client = serverId ? getPaseoClient(serverId) : selected;
        const { entries } = await client.agents.list();
        setResult(`${serverId ?? "Selected host"}: ${entries.length} agents`);
      } catch (error) {
        setResult(error instanceof Error ? error.message : String(error));
      }
    },
    [selected],
  );
  const styles = useMemo(
    () => ({
      root: { padding: 16, gap: 12, backgroundColor: theme.colors.surface0 },
      text: { color: theme.colors.foreground },
    }),
    [theme],
  );
  const listSelected = useCallback(() => {
    void list();
  }, [list]);
  const rows = hosts.map((host) => ({
    serverId: host.serverId,
    label: host.label,
    status: host.status,
    onPress() {
      void list(host.serverId);
    },
  }));
  return (
    <View style={styles.root}>
      <Pressable accessibilityRole="button" onPress={listSelected}>
        <Text style={styles.text}>List selected host agents</Text>
      </Pressable>
      {rows.map((host) => (
        <Pressable key={host.serverId} accessibilityRole="button" onPress={host.onPress}>
          <Text style={styles.text}>
            {host.label}: {host.status}
          </Text>
        </Pressable>
      ))}
      <Text style={styles.text}>{result}</Text>
    </View>
  );
}
