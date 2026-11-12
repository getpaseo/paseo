import { Component, useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import {
  useHosts,
  useTerminals,
  useTerminal,
  usePaseo,
  type TerminalRef,
  type PluginSidebarViewProps,
} from "@getpaseo/plugin/client";
import { Heading } from "./rows";

class TerminalError extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? <Text>{this.state.error.message}</Text> : this.props.children;
  }
}
function TerminalRow({
  reference,
  view,
}: {
  reference: TerminalRef;
  view: PluginSidebarViewProps;
}) {
  const terminal = useTerminal(reference);
  const paseo = usePaseo();
  const focus = useCallback(() => paseo.terminals.ref(reference).focus(), [paseo, reference]);
  const close = useMutation({ mutationFn: () => paseo.terminals.ref(reference).kill() });
  const kill = useCallback(() => close.mutate(), [close]);
  const style = useMemo(
    () => ({ color: view.theme.colors.foreground, fontSize: 12, padding: 12 }),
    [view.theme],
  );
  if (!terminal) return null;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Focus terminal ${terminal.title}`}
        testID={`sidebar-terminal-open-${reference.id}`}
        onPress={focus}
      >
        <Text style={style}>
          {terminal.title}
          {terminal.isScript ? " (script)" : ""}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Kill terminal ${terminal.title}`}
        testID={`sidebar-terminal-kill-${reference.id}`}
        disabled={close.isPending}
        onPress={kill}
      >
        <Text style={style}>Close terminal</Text>
      </Pressable>
      {close.error ? <Text style={style}>{close.error.message}</Text> : null}
    </View>
  );
}
function HostTerminals({ hostId, view }: { hostId: string; view: PluginSidebarViewProps }) {
  const terminals = useTerminals({ hosts: [hostId], orderBy: "createdAt" });
  return (
    <View>
      {terminals.length ? (
        terminals.map((reference) => (
          <TerminalRow key={reference.key} reference={reference} view={view} />
        ))
      ) : (
        <Heading title="No terminals" view={view} />
      )}
    </View>
  );
}
function HostButton({
  hostId,
  label,
  select,
  view,
}: {
  hostId: string;
  label: string;
  select: (id: string) => void;
  view: PluginSidebarViewProps;
}) {
  const choose = useCallback(() => select(hostId), [select, hostId]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Terminals on ${hostId}`}
      onPress={choose}
    >
      <Heading title={label} view={view} />
    </Pressable>
  );
}
export function Terminals(view: PluginSidebarViewProps) {
  const hosts = useHosts();
  const [chosen, select] = useState<string | null>(null);
  const selected = chosen;
  return (
    <ScrollView>
      {hosts.map((host) => (
        <HostButton
          key={host.serverId}
          hostId={host.serverId}
          label={host.label}
          select={select}
          view={view}
        />
      ))}
      {selected ? (
        <TerminalError key={selected}>
          <HostTerminals hostId={selected} view={view} />
        </TerminalError>
      ) : (
        <Heading
          title={
            hosts.length ? "Choose a host to list terminals" : "Connect a host to list terminals"
          }
          view={view}
        />
      )}
    </ScrollView>
  );
}
