import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import { SPACING, type Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

// Shared presentation primitives for the app's directory trees. Both the Files
// explorer (server-loaded listings) and the Changes view (client-built from diff
// paths) render different data, but their ROWS should look identical — same
// indentation, guide lines, and chevron. Keep those here so the two trees can't
// drift apart.
export const TREE_INDENT_PER_LEVEL = 16;

/** Left padding for a tree row at `depth`. Shared by folder rows and file headers
 * in the Changes tree so their indentation can't drift apart. */
export function treeRowPaddingLeft(depth: number): number {
  return SPACING[3] + depth * TREE_INDENT_PER_LEVEL;
}

const foregroundMutedIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedChevronRight = withUnistyles(ChevronRight);

/**
 * Vertical guide lines connecting nested rows to their ancestors — one line per
 * ancestor depth level, positioned absolutely within the (relative) row. Renders
 * nothing at depth 0.
 */
export function TreeIndentGuides({ depth }: { depth: number }) {
  const guides = useMemo(
    () =>
      Array.from({ length: depth }, (_, index) => ({
        key: index,
        style: [
          styles.indentGuide,
          inlineUnistylesStyle({ left: SPACING[3] + index * TREE_INDENT_PER_LEVEL + 4 }),
        ],
      })),
    [depth],
  );
  return (
    <>
      {guides.map((guide) => (
        <View key={guide.key} style={guide.style} pointerEvents="none" />
      ))}
    </>
  );
}

/** Rotating disclosure chevron for a directory row (points right; rotates down when expanded). */
export function TreeChevron({ expanded }: { expanded: boolean }) {
  return (
    <View style={expanded ? [styles.chevron, styles.chevronExpanded] : styles.chevron}>
      <ThemedChevronRight size={16} uniProps={foregroundMutedIconColorMapping} />
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  indentGuide: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: theme.colors.surface2,
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
}));
