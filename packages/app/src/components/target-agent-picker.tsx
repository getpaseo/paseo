import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { Check, Cpu, Terminal } from "lucide-react-native";

import { useCliAgents } from "@/hooks/use-cli-agents";
import { settingsStyles } from "@/styles/settings";

/** Always-available virtual target: the Hubcode GUI itself. */
const GUI_TARGET = { id: "hubcode-gui", name: "Hubcode (GUI)" } as const;

export interface TargetAgentPickerProps {
  serverId: string | null;
  /** Currently selected agent ids. Empty list = install everywhere. */
  value: string[];
  onChange: (ids: string[]) => void;
}

/**
 * Multi-select over the CLI agents detected on this host plus the Hubcode
 * GUI. Leaves the list empty = install into every supported agent (the
 * adapter interprets `targetAgents: undefined` as "all").
 */
export function TargetAgentPicker({ serverId, value, onChange }: TargetAgentPickerProps) {
  const { theme } = useUnistyles();
  const cli = useCliAgents(serverId ?? null);
  const selected = useMemo(() => new Set(value), [value]);

  const options = useMemo(() => {
    const list: Array<{ id: string; name: string; isGui: boolean; installed: boolean }> = [
      { id: GUI_TARGET.id, name: GUI_TARGET.name, isGui: true, installed: true },
    ];
    for (const agent of cli.installedAgents) {
      list.push({ id: agent.id, name: agent.name, isGui: false, installed: true });
    }
    return list;
  }, [cli.installedAgents]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };

  return (
    <View style={{ gap: 6 }}>
      <Text style={settingsStyles.rowHint}>Leave empty to install into every supported agent.</Text>

      {options.length === 0 ? (
        <Text style={settingsStyles.rowHint}>
          No agents detected on this host yet. Activate a CLI in Settings → CLI Agents.
        </Text>
      ) : (
        <View
          style={{
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 8,
            backgroundColor: theme.colors.surface1,
            paddingVertical: 4,
          }}
        >
          {options.map((opt) => {
            const isOn = selected.has(opt.id);
            const Icon = opt.isGui ? Cpu : Terminal;
            return (
              <Pressable
                key={opt.id}
                onPress={() => toggle(opt.id)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 10,
                  paddingVertical: 7,
                  gap: 8,
                }}
              >
                <View
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 3,
                    borderWidth: 1,
                    borderColor: isOn ? theme.colors.foreground : theme.colors.border,
                    backgroundColor: isOn ? theme.colors.foreground : "transparent",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {isOn ? <Check size={10} color={theme.colors.background} /> : null}
                </View>
                <Icon size={12} color={theme.colors.mutedForeground} />
                <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{opt.name}</Text>
                <Text style={{ color: theme.colors.mutedForeground, fontSize: 11 }}>{opt.id}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}
