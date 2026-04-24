import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { Check, Folder } from "lucide-react-native";

import { useProjectsList } from "@/hooks/use-projects-list";
import { settingsStyles } from "@/styles/settings";

export interface ProjectPickerProps {
  serverId: string | null;
  /** Currently selected project root paths. */
  value: string[];
  onChange: (paths: string[]) => void;
  maxHeight?: number;
}

/**
 * Multi-select over the projects this daemon knows about (derived from
 * workspaces streamed into the session store). Stores selected project
 * *root paths*, matching the existing `projectPaths` schema field.
 */
export function ProjectPicker({ serverId, value, onChange, maxHeight = 240 }: ProjectPickerProps) {
  const { theme } = useUnistyles();
  const projects = useProjectsList(serverId);
  const [search, setSearch] = useState("");
  const selected = useMemo(() => new Set(value), [value]);

  const filtered = useMemo(() => {
    if (!search.trim()) return projects;
    const q = search.toLowerCase();
    return projects.filter(
      (p) => p.displayName.toLowerCase().includes(q) || p.rootPath.toLowerCase().includes(q),
    );
  }, [projects, search]);

  const toggle = (rootPath: string) => {
    const next = new Set(selected);
    if (next.has(rootPath)) next.delete(rootPath);
    else next.add(rootPath);
    onChange(Array.from(next));
  };

  return (
    <View style={{ gap: 6 }}>
      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder="Search projects…"
        placeholderTextColor={theme.colors.mutedForeground}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          backgroundColor: theme.colors.surface1,
          color: theme.colors.foreground,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 6,
          fontSize: 13,
          borderWidth: 1,
          borderColor: theme.colors.border,
        }}
      />

      {projects.length === 0 ? (
        <Text style={settingsStyles.rowHint}>
          No projects registered yet. Create a workspace first, then come back.
        </Text>
      ) : (
        <ScrollView
          style={{
            maxHeight,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 8,
            backgroundColor: theme.colors.surface1,
          }}
          contentContainerStyle={{ paddingVertical: 4 }}
        >
          {filtered.length === 0 ? (
            <Text style={[settingsStyles.rowHint, { padding: 10 }]}>
              No projects match "{search}".
            </Text>
          ) : (
            filtered.map((p) => {
              const isOn = selected.has(p.rootPath);
              return (
                <Pressable
                  key={p.id}
                  onPress={() => toggle(p.rootPath)}
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
                  <Folder size={12} color={theme.colors.mutedForeground} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
                      {p.displayName}
                    </Text>
                    <Text
                      style={{ color: theme.colors.mutedForeground, fontSize: 11 }}
                      numberOfLines={1}
                    >
                      {p.rootPath}
                    </Text>
                  </View>
                  {p.workspaceCount > 0 ? (
                    <Text style={{ fontSize: 10, color: theme.colors.mutedForeground }}>
                      {p.workspaceCount} ws
                    </Text>
                  ) : null}
                </Pressable>
              );
            })
          )}
        </ScrollView>
      )}
      {value.length > 0 ? (
        <Text style={settingsStyles.rowHint}>
          {value.length} project{value.length === 1 ? "" : "s"} selected.
        </Text>
      ) : null}
    </View>
  );
}
