import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import { SPACING, type Theme } from "@/styles/theme";

// Shared presentation primitives for the app's directory trees. Both the Files
// explorer (server-loaded listings) and the Changes view (client-built from diff
// paths) render different data, but their ROWS should look identical — same
// indentation, density, name emphasis, and chevron. Keep those here so the two trees can't
// drift apart.
export const TREE_INDENT_PER_LEVEL = 12;
export const WORKSPACE_FILE_ROW_VERTICAL_PADDING = SPACING[1.5];
export const WORKSPACE_TREE_ICON_SIZE = 16;
export const WORKSPACE_TREE_LOADING_ICON_SIZE = 14;
export const WORKSPACE_TREE_ICON_LABEL_GAP = SPACING[2];
/**
 * Trailing glyph rail shared with the explorer X and Changes options chevron.
 * The extra 2px is optical: text ink ends inside its layout box, while the
 * header icons' strokes extend to theirs.
 */
export const WORKSPACE_FILE_ROW_TRAILING_PADDING = SPACING[4] + 2;

/** Left padding for a row in either workspace tree. */
export function treeRowPaddingLeft(depth: number): number {
  return SPACING[3] + depth * TREE_INDENT_PER_LEVEL;
}

const foregroundExtraMutedIconColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
});

const ThemedChevronRight = withUnistyles(ChevronRight);

/** Rotating disclosure chevron for a directory row (points right; rotates down when expanded). */
export function TreeChevron({ expanded }: { expanded: boolean }) {
  return (
    <View style={expanded ? [styles.chevron, styles.chevronExpanded] : styles.chevron}>
      <ThemedChevronRight
        size={WORKSPACE_TREE_ICON_SIZE}
        uniProps={foregroundExtraMutedIconColorMapping}
      />
    </View>
  );
}

export const workspaceTreeRowStyles = StyleSheet.create((theme: Theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: WORKSPACE_FILE_ROW_VERTICAL_PADDING,
    paddingRight: WORKSPACE_FILE_ROW_TRAILING_PADDING,
  },
  active: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  name: { color: theme.colors.foreground, opacity: 0.76 },
  nameHovered: { opacity: 1 },
}));

const styles = StyleSheet.create((_theme: Theme) => ({
  chevron: {
    width: WORKSPACE_TREE_ICON_SIZE,
    height: WORKSPACE_TREE_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
}));
