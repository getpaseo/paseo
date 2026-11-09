import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useComposers, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { REVIEW_KEY } from "./controls";

/**
 * Lives in the Explorer, away from any composer, and reaches the composer of the agent whose tab
 * is focused. The agent's tab does not have to be open for the composer to exist: the text lands in
 * its prompt either way.
 */
export function ComposerTools({ theme, layout }: PluginWorkspacePanelProps) {
  const [focused] = useComposers({ focused: true });
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        gap: 12,
        backgroundColor: theme.colors.surface0,
      },
      label: { color: theme.colors.foregroundMuted },
      button: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: focused ? theme.colors.accent : theme.colors.surface2,
      },
      buttonText: {
        color: focused ? theme.colors.accentForeground : theme.colors.foregroundMuted,
        textAlign: "center" as const,
      },
    }),
    [focused, layout.compact, theme],
  );
  const insert = useCallback(() => focused?.insertText("- [ ] Tests\n- [ ] Docs\n"), [focused]);
  return (
    <View style={styles.screen}>
      <Text style={styles.label}>
        {focused ? `Focused agent: ${focused.agent.provider}` : "No agent is focused"}
      </Text>
      {focused ? (
        <Text style={styles.label}>
          {focused.agent.metadata[REVIEW_KEY] === true ? "Needs review: yes" : "Needs review: no"}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Insert checklist into the focused agent"
        disabled={!focused}
        onPress={insert}
        style={styles.button}
      >
        <Text style={styles.buttonText}>Insert checklist into the focused agent</Text>
      </Pressable>
    </View>
  );
}
