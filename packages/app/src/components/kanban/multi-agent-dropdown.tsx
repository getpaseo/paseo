// MultiAgentDropdown — adapted from emdash for React Native
// Multi-select agent picker with run counts (1-4x)
import { useState, useCallback } from "react";
import { View, Text, Pressable, FlatList, Modal } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown, Check, Minus, Plus, Info } from "lucide-react-native";
import { type Agent, AGENT_CONFIG } from "./agent-selector";

const MAX_RUNS = 4;

export interface AgentRun {
  agent: Agent;
  runs: number;
}

interface MultiAgentDropdownProps {
  agentRuns: AgentRun[];
  onChange: (agentRuns: AgentRun[]) => void;
  disabledAgents?: Agent[];
}

export function MultiAgentDropdown({
  agentRuns,
  onChange,
  disabledAgents = [],
}: MultiAgentDropdownProps) {
  const { theme } = useUnistyles();
  const [isOpen, setIsOpen] = useState(false);

  const selectedAgents = new Set(agentRuns.map((ar) => ar.agent));

  const toggleAgent = useCallback(
    (agent: Agent) => {
      if (disabledAgents.includes(agent)) return;
      if (selectedAgents.has(agent)) {
        if (agentRuns.length > 1) {
          onChange(agentRuns.filter((ar) => ar.agent !== agent));
        }
      } else {
        onChange([...agentRuns, { agent, runs: 1 }]);
      }
    },
    [agentRuns, onChange, disabledAgents, selectedAgents],
  );

  const updateRuns = useCallback(
    (agent: Agent, delta: number) => {
      onChange(
        agentRuns.map((ar) => {
          if (ar.agent !== agent) return ar;
          const next = Math.max(1, Math.min(MAX_RUNS, ar.runs + delta));
          return { ...ar, runs: next };
        }),
      );
    },
    [agentRuns, onChange],
  );

  const triggerText = agentRuns
    .map((ar) => {
      const name = AGENT_CONFIG[ar.agent]?.label;
      return ar.runs > 1 ? `${name} (${ar.runs}x)` : name;
    })
    .join(", ");

  return (
    <View>
      <Pressable onPress={() => setIsOpen(true)} style={styles.trigger}>
        <Text style={styles.triggerText} numberOfLines={1}>
          {triggerText}
        </Text>
        <ChevronDown size={14} color={theme.colors.foregroundMuted} />
      </Pressable>

      <Modal
        visible={isOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setIsOpen(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setIsOpen(false)}>
          <View style={styles.dropdown}>
            <FlatList
              data={Object.entries(AGENT_CONFIG)}
              keyExtractor={([key]) => key}
              renderItem={({ item: [key, config] }) => {
                const agent = key as Agent;
                const isSelected = selectedAgents.has(agent);
                const isDisabled = disabledAgents.includes(agent);
                const isLastSelected = isSelected && agentRuns.length === 1;
                const runs = agentRuns.find((ar) => ar.agent === agent)?.runs ?? 1;

                return (
                  <View style={[styles.row, isDisabled && styles.rowDisabled]}>
                    <Pressable
                      style={styles.checkArea}
                      onPress={() => !isDisabled && !isLastSelected && toggleAgent(agent)}
                      disabled={isDisabled || isLastSelected}
                    >
                      <View
                        style={[
                          styles.checkbox,
                          isSelected && styles.checkboxSelected,
                          isLastSelected && styles.checkboxLocked,
                        ]}
                      >
                        {isSelected ? <Check size={10} color="#fff" /> : null}
                      </View>
                      <Text style={[styles.rowText, isDisabled && styles.rowTextDisabled]}>
                        {config.label}
                        {isDisabled ? " (in use)" : ""}
                      </Text>
                    </Pressable>

                    {isSelected ? (
                      <View style={styles.runsControl}>
                        <Pressable
                          onPress={() => updateRuns(agent, -1)}
                          disabled={runs <= 1}
                          hitSlop={6}
                        >
                          <Minus
                            size={12}
                            color={runs <= 1 ? theme.colors.surface2 : theme.colors.foregroundMuted}
                          />
                        </Pressable>
                        <Text style={styles.runsText}>{runs}x</Text>
                        <Pressable
                          onPress={() => updateRuns(agent, 1)}
                          disabled={runs >= MAX_RUNS}
                          hitSlop={6}
                        >
                          <Plus
                            size={12}
                            color={
                              runs >= MAX_RUNS
                                ? theme.colors.surface2
                                : theme.colors.foregroundMuted
                            }
                          />
                        </Pressable>
                      </View>
                    ) : null}
                  </View>
                );
              }}
            />
            <View style={styles.infoRow}>
              <Info size={10} color={theme.colors.foregroundMuted} />
              <Text style={styles.infoText}>
                Run up to {MAX_RUNS} instances per agent to compare solutions.
              </Text>
            </View>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  triggerText: { flex: 1, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  overlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.3)",
  },
  dropdown: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    width: 280,
    maxHeight: 400,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  rowDisabled: { opacity: 0.5 },
  checkArea: { flex: 1, flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: theme.colors.foregroundMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxSelected: {
    backgroundColor: theme.colors.foreground,
    borderColor: theme.colors.foreground,
  },
  checkboxLocked: { opacity: 0.5 },
  rowText: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  rowTextDisabled: { color: theme.colors.foregroundMuted },
  runsControl: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  runsText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    minWidth: 20,
    textAlign: "center",
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[3],
  },
  infoText: { fontSize: 10, color: theme.colors.foregroundMuted, flex: 1 },
}));
