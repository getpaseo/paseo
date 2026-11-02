import {
  addHost,
  getPaseoClient,
  useHosts,
  usePaseo,
  type PluginSurfaceProps,
  type PluginHost,
} from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

export function Hosts({ theme }: PluginSurfaceProps) {
  const hosts = useHosts();
  const selected = usePaseo();
  const [result, setResult] = useState("");
  const [connection, setConnection] = useState("");
  const add = useCallback(async () => {
    try {
      const outcome = await addHost({ connection });
      if (outcome.status === "saved") setResult(`Added ${outcome.host.label}`);
      else if (outcome.status === "cancelled") setResult("Host addition cancelled");
      else setResult("Add ?password= and retry");
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    }
  }, [connection]);
  const addPressed = useCallback(() => {
    void add();
  }, [add]);
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
  return (
    <View style={styles.root}>
      <TextInput
        value={connection}
        onChangeText={setConnection}
        placeholder="host:port, ssh://user@host, or a pairing link"
      />
      <Pressable accessibilityRole="button" onPress={addPressed}>
        <Text style={styles.text}>Add host</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={listSelected}>
        <Text style={styles.text}>List selected host agents</Text>
      </Pressable>
      {hosts.map((host) => (
        <HostRow key={host.serverId} host={host} color={theme.colors.foreground} list={list} />
      ))}
      <Text style={styles.text}>{result}</Text>
    </View>
  );
}

function HostRow({
  host,
  color,
  list,
}: {
  host: PluginHost;
  color: string;
  list: (serverId: string) => Promise<void>;
}) {
  const style = useMemo(() => ({ color }), [color]);
  const rowStyle = useMemo(() => ({ gap: 4 }), []);
  const listAgents = useCallback(() => void list(host.serverId), [host, list]);
  const update = useCallback(
    () => void host.update({ label: `${host.label} (build)`, appearance: { color: "sky" } }),
    [host],
  );
  const open = useCallback(() => host.openSettings(), [host]);
  const remove = useCallback(() => void host.remove(), [host]);
  return (
    <View style={rowStyle}>
      <Text style={style}>
        {host.label}: {host.status} ·{" "}
        {host.connections.map((connection) => connection.uri ?? "via another host").join(", ")}
      </Text>
      <Pressable accessibilityRole="button" onPress={listAgents}>
        <Text style={style}>List agents</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={update}>
        <Text style={style}>Rename and color</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={open}>
        <Text style={style}>Host settings</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={remove}>
        <Text style={style}>Remove host</Text>
      </Pressable>
    </View>
  );
}
