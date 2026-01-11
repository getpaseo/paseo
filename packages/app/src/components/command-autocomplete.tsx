import { View, Text, Pressable, ScrollView } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useAgentCommandsQuery } from "@/hooks/use-agent-commands-query";
import { Fonts } from "@/constants/theme";
import { Theme } from "@/styles/theme";

interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

interface CommandAutocompleteProps {
  serverId: string;
  agentId: string;
  filter: string;
  selectedIndex: number;
  onSelect: (command: AgentSlashCommand) => void;
}

export function CommandAutocomplete({
  serverId,
  agentId,
  filter,
  selectedIndex,
  onSelect,
}: CommandAutocompleteProps) {
  const { theme } = useUnistyles();
  const { commands, isLoading, isError, error } = useAgentCommandsQuery({
    serverId,
    agentId,
    enabled: true,
  });

  // Filter commands based on input after /
  const filterLower = filter.toLowerCase();
  const filteredCommands = commands.filter((cmd) =>
    cmd.name.toLowerCase().includes(filterLower)
  );

  if (isLoading) {
    return (
      <View style={styles.container}>
        <View style={styles.loadingItem}>
          <Text style={styles.loadingText}>Loading commands...</Text>
        </View>
      </View>
    );
  }

  if (isError) {
    return (
      <View style={styles.container}>
        <View style={styles.emptyItem}>
          <Text style={styles.emptyText}>Error: {error?.message ?? "Failed to load"}</Text>
        </View>
      </View>
    );
  }

  if (filteredCommands.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.emptyItem}>
          <Text style={styles.emptyText}>No commands found</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollView} keyboardShouldPersistTaps="always">
        {filteredCommands.map((cmd, index) => {
          const isSelected = index === selectedIndex;
          return (
            <Pressable
              key={cmd.name}
              onPress={() => onSelect(cmd)}
              style={[
                styles.commandItem,
                isSelected && {
                  backgroundColor: theme.colors.accent,
                },
              ]}
            >
              <View style={styles.commandHeader}>
                <Text style={styles.commandName}>/{cmd.name}</Text>
                {cmd.argumentHint && (
                  <Text style={styles.commandArgs}>{cmd.argumentHint}</Text>
                )}
              </View>
              <Text style={styles.commandDescription} numberOfLines={1}>
                {cmd.description}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function useCommandAutocomplete(commands: AgentSlashCommand[], filter: string) {
  const filterLower = filter.toLowerCase();
  return commands.filter((cmd) => cmd.name.toLowerCase().includes(filterLower));
}

const styles = StyleSheet.create(((theme: Theme) => ({
  container: {
    backgroundColor: theme.colors.card,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    maxHeight: 200,
  },
  scrollView: {
    flexGrow: 0,
    flexShrink: 1,
  },
  commandItem: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  commandHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  commandName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    fontFamily: Fonts.mono,
  },
  commandArgs: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    fontFamily: Fonts.mono,
  },
  commandDescription: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    marginTop: 2,
  },
  loadingItem: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  loadingText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
  },
  emptyItem: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  emptyText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
  },
})) as any) as Record<string, any>;
