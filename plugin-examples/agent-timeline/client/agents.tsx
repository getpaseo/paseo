import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginScreenProps, usePaseo } from "@getpaseo/plugin/client";
import { AgentTimeline, type AgentTimelineComposer } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

type ComposerChoice = "simple" | "full" | "no-composer";

const COMPOSERS: Record<ComposerChoice, false | AgentTimelineComposer> = {
  simple: { controls: "none", placeholder: "Message this agent" },
  full: { controls: { attachments: "hidden" } },
  "no-composer": false,
};

const CHOICES: readonly { id: ComposerChoice; label: string }[] = [
  { id: "simple", label: "Simple" },
  { id: "full", label: "Full" },
  { id: "no-composer", label: "No composer" },
];

interface AgentRow {
  id: string;
  title: string;
}

function useStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(
    () => ({
      root: { flex: 1, flexDirection: "row" as const, backgroundColor: theme.colors.surface0 },
      list: {
        width: compact ? undefined : 260,
        // A web ScrollView grows by default; a fixed list must not.
        flexGrow: compact ? 1 : 0,
        borderRightWidth: compact ? 0 : 1,
        borderColor: theme.colors.border,
      },
      row: { paddingHorizontal: 16, paddingVertical: 10 },
      rowActive: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface2,
      },
      text: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted, padding: 16 },
      detail: { flex: 1, minWidth: 0 },
      bar: {
        flexDirection: "row" as const,
        gap: 8,
        padding: 8,
        alignItems: "center" as const,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
      },
      chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
      chipActive: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
      },
    }),
    [compact, theme],
  );
}

type Styles = ReturnType<typeof useStyles>;

function AgentButton({
  agent,
  active,
  styles,
  onSelect,
}: {
  agent: AgentRow;
  active: boolean;
  styles: Styles;
  onSelect(agentId: string): void;
}) {
  const press = useCallback(() => onSelect(agent.id), [agent.id, onSelect]);
  return (
    <Pressable
      accessibilityRole="button"
      style={active ? styles.rowActive : styles.row}
      onPress={press}
    >
      <Text style={styles.text}>{agent.title}</Text>
    </Pressable>
  );
}

function ChoiceChip({
  choice,
  label,
  active,
  styles,
  onChoose,
}: {
  choice: ComposerChoice;
  label: string;
  active: boolean;
  styles: Styles;
  onChoose(choice: ComposerChoice): void;
}) {
  const press = useCallback(() => onChoose(choice), [choice, onChoose]);
  const state = useMemo(() => ({ selected: active }), [active]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={state}
      style={active ? styles.chipActive : styles.chip}
      onPress={press}
    >
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  );
}

export function Agents({ theme, layout, navigation }: PluginScreenProps) {
  const paseo = usePaseo();
  const [selected, setSelected] = useState<string | null>(null);
  const [choice, setChoice] = useState<ComposerChoice>("simple");
  const agents = useQuery({
    queryKey: ["agents"],
    async queryFn(): Promise<AgentRow[]> {
      const { entries } = await paseo.agents.list();
      return entries.map(({ agent }) => ({ id: agent.id, title: agent.title ?? agent.id }));
    },
  });
  const styles = useStyles(theme, layout.compact);
  const openAgent = useCallback(() => {
    if (selected) navigation?.openAgent({ agentId: selected });
  }, [navigation, selected]);

  // On a phone the list and the timeline take turns filling the screen.
  const showList = !layout.compact || selected === null;

  return (
    <View style={styles.root}>
      {showList ? (
        <ScrollView style={styles.list} testID="example-agent-list">
          {agents.isPending ? <Text style={styles.muted}>Loading agents…</Text> : null}
          {agents.isError ? <Text style={styles.muted}>{agents.error.message}</Text> : null}
          {agents.data?.map((agent) => (
            <AgentButton
              key={agent.id}
              agent={agent}
              active={agent.id === selected}
              styles={styles}
              onSelect={setSelected}
            />
          ))}
        </ScrollView>
      ) : null}
      {selected === null ? (
        <Text style={styles.muted}>{layout.compact ? null : "Choose an agent"}</Text>
      ) : (
        <View style={styles.detail}>
          <View style={styles.bar} testID="example-composer-choices">
            {CHOICES.map((option) => (
              <ChoiceChip
                key={option.id}
                choice={option.id}
                label={option.label}
                active={option.id === choice}
                styles={styles}
                onChoose={setChoice}
              />
            ))}
          </View>
          {/* Older hosts have no AgentTimeline; send the user to the agent's tab instead. */}
          {typeof AgentTimeline === "function" ? (
            <AgentTimeline
              agentId={selected}
              composer={COMPOSERS[choice]}
              testID="example-agent-timeline"
            />
          ) : (
            <Pressable accessibilityRole="button" onPress={openAgent}>
              <Text style={styles.text}>Open agent</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}
