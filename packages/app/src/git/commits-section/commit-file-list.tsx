import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { StyleSheet } from "react-native-unistyles";
import type { CheckoutCommit } from "@getpaseo/protocol/messages";
import { DiffStat } from "@/components/diff-stat";
import { getFileIconSvg } from "@/components/material-file-icons";
import { DirectoryRow } from "@/git/changed-files-tree-row";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { buildDiffTree, collectDirectoryPaths, type DiffTreeInputFile } from "@/utils/diff-tree";
import { CommitFileDiffView } from "./commit-file-diff-view";
import type { CheckoutCommitFile, FilePressHandler } from "./shared";

const INDENT_PER_LEVEL = 16;

interface CommitFileRowProps {
  commit: CheckoutCommit;
  file: CheckoutCommitFile;
  // Label shown for the row: the full path in list mode, the basename in tree
  // mode (where parent directories are already visible as rows).
  label: string;
  isOpen: boolean;
  depth: number;
  onFilePress: FilePressHandler;
}

const CommitFileRow = memo(function CommitFileRow({
  commit,
  file,
  label,
  isOpen,
  depth,
  onFilePress,
}: CommitFileRowProps) {
  const handlePress = useCallback(() => {
    onFilePress(commit, file);
  }, [commit, file, onFilePress]);

  // Base padding comes from the theme; the depth offset is a dynamic value that
  // bypasses the Unistyles CSS registry via the inline-style lane as marginLeft
  // (mirrors DirectoryRow, see docs/unistyles.md).
  const rowStyle = useMemo(
    () => [
      styles.fileRow,
      isOpen && styles.fileRowOpen,
      inlineUnistylesStyle({ marginLeft: depth * INDENT_PER_LEVEL }),
    ],
    [isOpen, depth],
  );
  const accessibilityState = useMemo(() => ({ expanded: isOpen }), [isOpen]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      testID={`commit-file-${file.path}`}
      onPress={handlePress}
      style={rowStyle}
    >
      <View style={styles.fileIcon}>
        <SvgXml xml={getFileIconSvg(file.path)} width={16} height={16} />
      </View>
      <Text style={styles.filePath} numberOfLines={1}>
        {label}
      </Text>
      <DiffStat additions={file.additions} deletions={file.deletions} />
    </Pressable>
  );
});

interface CommitTreeDirectoryRowProps {
  path: string;
  name: string;
  depth: number;
  additions: number;
  deletions: number;
  expanded: boolean;
  onToggle: (path: string) => void;
}

// Binds the path into a stable onToggle so each directory row receives a stable
// closure (react-perf/jsx-no-new-function-as-prop) and memoization holds.
const CommitTreeDirectoryRow = memo(function CommitTreeDirectoryRow({
  path,
  name,
  depth,
  additions,
  deletions,
  expanded,
  onToggle,
}: CommitTreeDirectoryRowProps) {
  const handleToggle = useCallback(() => onToggle(path), [onToggle, path]);
  return (
    <DirectoryRow
      name={name}
      depth={depth}
      additions={additions}
      deletions={deletions}
      expanded={expanded}
      onToggle={handleToggle}
      testID={`commit-file-dir-${path}`}
    />
  );
});

interface CommitFileListProps {
  commit: CheckoutCommit;
  fileView: "list" | "tree";
  serverId: string;
  cwd: string;
  openFilePath: string | null;
  onFilePress: FilePressHandler;
}

/**
 * Renders an expanded commit's changed files, honoring the global Changes
 * `fileView` preference: a flat list, or a collapsible directory tree that
 * reuses the same `DirectoryRow` and diff-tree utilities as the Changes panel.
 *
 * The inline diff (`openFilePath`) is owned by the parent `CommitRow` so it
 * survives across both modes; this component only owns directory collapse state.
 */
export const CommitFileList = memo(function CommitFileList({
  commit,
  fileView,
  serverId,
  cwd,
  openFilePath,
  onFilePress,
}: CommitFileListProps) {
  if (fileView === "tree") {
    return (
      <CommitFileTree
        commit={commit}
        serverId={serverId}
        cwd={cwd}
        openFilePath={openFilePath}
        onFilePress={onFilePress}
      />
    );
  }

  return (
    <View style={styles.files}>
      {commit.files.map((file) => (
        <View key={file.path}>
          <CommitFileRow
            commit={commit}
            file={file}
            label={file.path}
            depth={0}
            isOpen={openFilePath === file.path}
            onFilePress={onFilePress}
          />
          {openFilePath === file.path ? (
            <CommitFileDiffView serverId={serverId} cwd={cwd} sha={commit.sha} path={file.path} />
          ) : null}
        </View>
      ))}
    </View>
  );
});

interface CommitFileTreeProps {
  commit: CheckoutCommit;
  serverId: string;
  cwd: string;
  openFilePath: string | null;
  onFilePress: FilePressHandler;
}

function CommitFileTree({ commit, serverId, cwd, openFilePath, onFilePress }: CommitFileTreeProps) {
  // Directories default to expanded: we track only the explicitly collapsed
  // ones and subtract them from the full directory universe.
  const [collapsedDirPaths, setCollapsedDirPaths] = useState<ReadonlySet<string>>(() => new Set());

  const treeFiles = useMemo<DiffTreeInputFile[]>(
    () =>
      commit.files.map((file) => ({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
      })),
    [commit.files],
  );

  const fileByPath = useMemo(() => {
    const map = new Map<string, CheckoutCommitFile>();
    for (const file of commit.files) {
      map.set(file.path, file);
    }
    return map;
  }, [commit.files]);

  const rows = useMemo(() => {
    const allDirectories = collectDirectoryPaths(treeFiles);
    const expandedPaths = new Set<string>();
    for (const path of allDirectories) {
      if (!collapsedDirPaths.has(path)) {
        expandedPaths.add(path);
      }
    }
    return buildDiffTree({ files: treeFiles, expandedPaths });
  }, [treeFiles, collapsedDirPaths]);

  const toggleDir = useCallback((path: string) => {
    setCollapsedDirPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  return (
    <View style={styles.files}>
      {rows.map((row) => {
        if (row.kind === "directory") {
          const collapsed = collapsedDirPaths.has(row.path);
          return (
            <CommitTreeDirectoryRow
              key={`dir:${row.path}`}
              path={row.path}
              name={row.name}
              depth={row.depth}
              additions={row.additions}
              deletions={row.deletions}
              expanded={!collapsed}
              onToggle={toggleDir}
            />
          );
        }
        const file = fileByPath.get(row.path);
        if (!file) {
          return null;
        }
        return (
          <View key={`file:${row.path}`}>
            <CommitFileRow
              commit={commit}
              file={file}
              label={row.name}
              depth={row.depth}
              isOpen={openFilePath === row.path}
              onFilePress={onFilePress}
            />
            {openFilePath === row.path ? (
              <CommitFileDiffView serverId={serverId} cwd={cwd} sha={commit.sha} path={row.path} />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  files: {
    paddingLeft: theme.spacing[3],
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  fileRowOpen: {
    backgroundColor: theme.colors.surface2,
  },
  fileIcon: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  filePath: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
