import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { DiffStat } from "@/components/diff-stat";
import { ThemedChevron, chevronColorMapping } from "@/git/themed-chevron";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

const INDENT_PER_LEVEL = 16;

interface DirectoryRowProps {
  name: string;
  depth: number;
  additions: number;
  deletions: number;
  expanded: boolean;
  onToggle: () => void;
  testID?: string;
}

export function DirectoryRow({
  name,
  depth,
  additions,
  deletions,
  expanded,
  onToggle,
  testID,
}: DirectoryRowProps) {
  // Base padding comes from the theme; the depth offset is a high-churn dynamic
  // value that must bypass the Unistyles CSS registry, so it rides the
  // inline-style lane as marginLeft (docs/unistyles.md).
  const rowStyle = useMemo(
    () => [styles.row, inlineUnistylesStyle({ marginLeft: depth * INDENT_PER_LEVEL })],
    [depth],
  );

  const chevronStyle = useMemo(
    () => [styles.chevron, expanded && styles.chevronExpanded],
    [expanded],
  );

  return (
    <Pressable
      accessibilityRole="button"
      testID={testID ?? `changed-files-dir-${name}`}
      onPress={onToggle}
      style={rowStyle}
    >
      <View style={chevronStyle}>
        <ThemedChevron size={16} uniProps={chevronColorMapping} />
      </View>
      <Text style={styles.name} numberOfLines={1}>
        {name}
      </Text>
      <DiffStat additions={additions} deletions={deletions} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  chevron: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  name: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
