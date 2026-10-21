import {
  addRemoteSshHost,
  getPaseoClient,
  removeHost,
  useHosts,
  usePaseo,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

export function Hosts({ theme }: PluginSurfaceProps) {
  const hosts = useHosts();
  const selected = usePaseo();
  const [result, setResult] = useState("");
  const [target, setTarget] = useState("ssh://user@host");
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
  const add = useCallback(async () => {
    try {
      const host = await addRemoteSshHost({ target });
      setResult(`Added ${host.label} (${host.serverId}): ${host.status}`);
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    }
  }, [target]);
  const remove = useCallback(async (serverId: string) => {
    try {
      await removeHost(serverId);
      setResult(`Removed ${serverId}`);
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    }
  }, []);
  const styles = useMemo(
    () => ({
      root: { padding: 16, gap: 12, backgroundColor: theme.colors.surface0 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12 },
      text: { color: theme.colors.foreground },
      input: {
        color: theme.colors.foreground,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 8,
      },
    }),
    [theme],
  );
  const listSelected = useCallback(() => {
    void list();
  }, [list]);
  const addHost = useCallback(() => {
    void add();
  }, [add]);
  const rows = hosts.map((host) => ({
    serverId: host.serverId,
    label: host.label,
    status: host.status,
    onPress() {
      void list(host.serverId);
    },
    onRemove() {
      void remove(host.serverId);
    },
  }));
  return (
    <View style={styles.root}>
      <Pressable accessibilityRole="button" onPress={listSelected}>
        <Text style={styles.text}>List selected host agents</Text>
      </Pressable>
      {rows.map((host) => (
        <View key={host.serverId} style={styles.row}>
          <Pressable accessibilityRole="button" onPress={host.onPress}>
            <Text style={styles.text}>
              {host.label}: {host.status}
            </Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={host.onRemove}>
            <Text style={styles.text}>Remove</Text>
          </Pressable>
        </View>
      ))}
      <TextInput
        style={styles.input}
        value={target}
        onChangeText={setTarget}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="ssh://user@host"
        placeholderTextColor={theme.colors.foregroundMuted}
      />
      <Pressable accessibilityRole="button" onPress={addHost}>
        <Text style={styles.text}>Add Remote SSH host</Text>
      </Pressable>
      <Text style={styles.text}>{result}</Text>
    </View>
  );
}
