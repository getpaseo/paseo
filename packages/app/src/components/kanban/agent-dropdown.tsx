// AgentDropdown — adapted from emdash for React Native
// Filtered agent dropdown showing only installed agents
import { useState, useCallback } from "react";
import { View, Text, Pressable, FlatList, Modal } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown, Check } from "lucide-react-native";
import { type Agent, AGENT_CONFIG } from "./agent-selector";

interface AgentDropdownProps {
  value: Agent;
  onChange: (agent: Agent) => void;
  installedAgents: Agent[];
  disabledAgents?: Agent[];
}

export function AgentDropdown({
  value,
  onChange,
  installedAgents,
  disabledAgents = [],
}: AgentDropdownProps) {
  const { theme } = useUnistyles();
  const [isOpen, setIsOpen] = useState(false);

  const installedSet = new Set(installedAgents);
  const agents = Object.entries(AGENT_CONFIG).filter(([key]) => installedSet.has(key as Agent));
  const currentConfig = AGENT_CONFIG[value];

  const handleSelect = useCallback(
    (agent: Agent) => {
      if (disabledAgents.includes(agent)) return;
      onChange(agent);
      setIsOpen(false);
    },
    [onChange, disabledAgents],
  );

  return (
    <View>
      <Pressable onPress={() => setIsOpen(true)} style={styles.trigger}>
        <Text style={styles.triggerText}>{currentConfig.label}</Text>
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
              data={agents}
              keyExtractor={([key]) => key}
              renderItem={({ item: [key, config] }) => {
                const isSelected = key === value;
                const isDisabled = disabledAgents.includes(key as Agent);
                return (
                  <Pressable
                    style={({ pressed }) => [
                      styles.row,
                      pressed && !isDisabled && styles.rowPressed,
                      isDisabled && styles.rowDisabled,
                    ]}
                    onPress={() => handleSelect(key as Agent)}
                    disabled={isDisabled}
                  >
                    <View style={styles.rowContent}>
                      <Text style={[styles.rowText, isDisabled && styles.rowTextDisabled]}>
                        {config.label}
                        {isDisabled ? " (in use)" : ""}
                      </Text>
                    </View>
                    {isSelected ? <Check size={14} color={theme.colors.foreground} /> : null}
                  </Pressable>
                );
              }}
            />
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
  triggerText: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
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
    width: 240,
    maxHeight: 300,
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
  rowPressed: { backgroundColor: theme.colors.surface2 },
  rowDisabled: { opacity: 0.5 },
  rowContent: { flex: 1 },
  rowText: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  rowTextDisabled: { color: theme.colors.foregroundMuted },
}));
