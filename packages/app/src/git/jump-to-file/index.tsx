import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { FolderTree } from "lucide-react-native";
import {
  AdaptiveModalSheet,
  SHEET_HEADER_CLOSE_PADDING_SCALE,
  SHEET_HORIZONTAL_PADDING_SCALE,
} from "@/components/adaptive-modal-sheet";
import {
  treeRowPaddingLeft,
  WORKSPACE_PANE_TRAILING_GLYPH_RAIL,
} from "@/components/tree-primitives";
import {
  FLOATING_ACTION_BUTTON_CLEARANCE,
  FloatingActionButton,
} from "@/components/ui/floating-action-button";
import { ChangedFilesTree } from "@/git/changed-files-tree";
import type { WorkingDiffMode } from "@/git/diff-document";
import type { ParsedDiffFile } from "@/git/use-diff-query";
import { ICON_SIZE, SPACING, type Theme } from "@/styles/theme";

// The sheet header indents its leading glyph by the sheet's own content inset,
// while a tree row indents itself by `treeRowPaddingLeft`. The body carries the
// difference so a depth-0 file icon lands on the header glyph's rail.
const TREE_LEADING_INSET = SPACING[SHEET_HORIZONTAL_PADDING_SCALE] - treeRowPaddingLeft(0);

// The header's close glyph sits at the content inset plus the button's own
// padding, while a tree row ends its trailing glyph at
// `WORKSPACE_PANE_TRAILING_GLYPH_RAIL`. The body carries the difference so row
// change icons land on the header X's rail.
const TREE_TRAILING_INSET =
  SPACING[SHEET_HORIZONTAL_PADDING_SCALE] +
  SPACING[SHEET_HEADER_CLOSE_PADDING_SCALE] -
  WORKSPACE_PANE_TRAILING_GLYPH_RAIL;

const ThemedFolderTree = withUnistyles(FolderTree);

const foregroundMutedIconColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

/** Scrollable space the diff keeps below its last line while the action is shown. */
export const JUMP_TO_FILE_CLEARANCE = FLOATING_ACTION_BUTTON_CLEARANCE;

export interface JumpToFileProps {
  files: ParsedDiffFile[];
  mode: WorkingDiffMode;
  onSelectFile: (path: string) => void;
}

/** Compact overview of a loaded diff: a floating action that opens the changed-files tree. */
export function JumpToFile({ files, mode, onSelectFile }: JumpToFileProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  // The sheet is a transient overview, so it always opens fully expanded and
  // never writes to the panel's persisted folder state.
  const [collapsedFolderPaths, setCollapsedFolderPaths] = useState<string[]>([]);
  const title = t("workspace.git.diff.jumpToFile.title");
  const header = useMemo(
    () => ({
      title,
      leading: <ThemedFolderTree size={ICON_SIZE.md} uniProps={foregroundMutedIconColorMapping} />,
    }),
    [title],
  );

  const open = useCallback(() => {
    setCollapsedFolderPaths([]);
    setIsOpen(true);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);
  const handleSelectFile = useCallback(
    (path: string) => {
      setIsOpen(false);
      onSelectFile(path);
    },
    [onSelectFile],
  );

  return (
    <>
      <FloatingActionButton
        icon={FolderTree}
        accessibilityLabel={title}
        onPress={open}
        testID="changes-jump-to-file"
      />
      <AdaptiveModalSheet
        header={header}
        visible={isOpen}
        onClose={close}
        scrollable={false}
        contentStyle={styles.sheetBody}
        testID="changes-jump-to-file-sheet"
      >
        <View style={styles.tree}>
          <ChangedFilesTree
            files={files}
            mode={mode}
            onSelectFile={handleSelectFile}
            collapsedFolderPaths={collapsedFolderPaths}
            onCollapsedFolderPathsChange={setCollapsedFolderPaths}
          />
        </View>
      </AdaptiveModalSheet>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Rows own their rails, so the sheet's horizontal inset is zeroed here.
  sheetBody: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
    gap: 0,
  },
  tree: {
    flex: 1,
    minHeight: 0,
    paddingLeft: TREE_LEADING_INSET,
    paddingRight: TREE_TRAILING_INSET,
    paddingTop: theme.spacing[2],
  },
}));
