import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { Folder, Globe, Sparkles, Terminal } from "lucide-react-native";

import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useCommands, type CommandWithState } from "@/hooks/use-commands";
import { settingsStyles } from "@/styles/settings";

/**
 * Quick-picker for slash commands surfaced right above the message composer.
 * Shows every *enabled* command across every scope, with search and scope
 * filter. Tap a command → we call `onInsert("plan")` and the composer inserts
 * `/plan ` at the current cursor position.
 */
export interface CommandPaletteProps {
  visible: boolean;
  serverId: string;
  onClose: () => void;
  onInsert: (commandName: string) => void;
}

type ScopeFilter = "all" | "global" | "project";

export function CommandPalette({ visible, serverId, onClose, onInsert }: CommandPaletteProps) {
  const { theme } = useUnistyles();
  const commands = useCommands(serverId);
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<ScopeFilter>("all");

  const items = useMemo<CommandWithState[]>(() => {
    const base = commands.commands.filter((c) => c.state.enabled);
    const scoped = scope === "all" ? base : base.filter((c) => c.definition.scope === scope);
    if (!search.trim()) return scoped;
    const q = search.toLowerCase();
    return scoped.filter(
      (c) =>
        c.definition.name.toLowerCase().includes(q) ||
        (c.definition.displayName ?? "").toLowerCase().includes(q) ||
        (c.definition.description ?? "").toLowerCase().includes(q) ||
        (c.definition.tags ?? []).some((t) => t.toLowerCase().includes(q)),
    );
  }, [commands.commands, scope, search]);

  const handleSelect = (name: string) => {
    onInsert(name);
    setSearch("");
  };

  return (
    <AdaptiveModalSheet visible={visible} onClose={onClose} title="Insert command">
      <View style={{ padding: 16, gap: 10 }}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search commands…"
          placeholderTextColor={theme.colors.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          style={{
            backgroundColor: theme.colors.surface1,
            color: theme.colors.foreground,
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 8,
            fontSize: 14,
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        />
        <SegmentedControl<ScopeFilter>
          value={scope}
          onValueChange={setScope}
          size="sm"
          options={[
            { value: "all", label: "All" },
            { value: "global", label: "Global" },
            { value: "project", label: "Project" },
          ]}
        />

        {commands.isLoading ? (
          <Text style={settingsStyles.rowHint}>Loading…</Text>
        ) : items.length === 0 ? (
          <View style={{ alignItems: "center", gap: 6, padding: 16 }}>
            <Terminal size={18} color={theme.colors.mutedForeground} />
            <Text style={settingsStyles.rowHint}>
              {commands.commands.length === 0
                ? "No commands installed yet. Create one in Settings → Commands."
                : "No enabled command matches this filter."}
            </Text>
          </View>
        ) : (
          <ScrollView
            style={{
              maxHeight: 360,
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: 8,
              backgroundColor: theme.colors.surface1,
            }}
            contentContainerStyle={{ paddingVertical: 4 }}
          >
            {items.map((entry) => (
              <CommandRow key={entry.definition.id} entry={entry} onSelect={handleSelect} />
            ))}
          </ScrollView>
        )}
      </View>
    </AdaptiveModalSheet>
  );
}

function CommandRow({
  entry,
  onSelect,
}: {
  entry: CommandWithState;
  onSelect: (name: string) => void;
}) {
  const { theme } = useUnistyles();
  const def = entry.definition;
  const ScopeIcon = def.scope === "global" ? Globe : Folder;
  return (
    <Pressable
      onPress={() => onSelect(def.name)}
      style={({ hovered, pressed }) => [
        {
          paddingHorizontal: 12,
          paddingVertical: 8,
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 10,
          backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
        },
      ]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {def.author === "builtin" ? <Sparkles size={12} color={theme.colors.foreground} /> : null}
          <Text style={{ fontFamily: "monospace", color: theme.colors.foreground, fontSize: 13 }}>
            /{def.name}
          </Text>
          {def.displayName && def.displayName !== def.name ? (
            <Text style={{ color: theme.colors.mutedForeground, fontSize: 12 }}>
              · {def.displayName}
            </Text>
          ) : null}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 3,
              backgroundColor: theme.colors.surface2,
              paddingHorizontal: 5,
              paddingVertical: 1,
              borderRadius: 3,
            }}
          >
            <ScopeIcon size={9} color={theme.colors.mutedForeground} />
            <Text style={{ fontSize: 9, color: theme.colors.mutedForeground }}>{def.scope}</Text>
          </View>
        </View>
        {def.description ? (
          <Text style={{ color: theme.colors.mutedForeground, fontSize: 12 }} numberOfLines={2}>
            {def.description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
