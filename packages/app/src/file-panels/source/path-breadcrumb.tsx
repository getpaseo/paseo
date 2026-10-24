import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSessionStore, type ExplorerEntry } from "@/stores/session-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  dirnamePath,
  joinAbsolutePath,
  pathsEqual,
  resolveFileBreadcrumb,
  toWorkspaceFileOpenPath,
  type FileBreadcrumbSegment,
} from "./path-breadcrumb-model";

interface FilePathBreadcrumbProps {
  serverId: string;
  workspaceRoot: string;
  path: string;
  /** Sit inside the pane toolbar instead of drawing its own row. */
  embedded?: boolean;
  onOpenFile: (openPath: string) => void;
}

type DirectoryState =
  | { status: "loading" }
  | { status: "ready"; entries: ExplorerEntry[] }
  | { status: "error"; message: string };

function sortEntries(entries: ExplorerEntry[]): ExplorerEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function directoryLabel(directory: string): string {
  const parts = directory.split("/").filter(Boolean);
  return parts.at(-1) ?? directory;
}

function DirectoryMenu({
  open,
  directory,
  currentAbsolutePath,
  serverId,
  workspaceRoot,
  onOpenFile,
}: {
  open: boolean;
  directory: string;
  currentAbsolutePath: string;
  serverId: string;
  workspaceRoot: string;
  onOpenFile: (openPath: string) => void;
}) {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const [browseDirectory, setBrowseDirectory] = useState(directory);
  const [state, setState] = useState<DirectoryState>({ status: "loading" });

  const load = useCallback(
    async (target: string) => {
      if (!client) {
        setState({ status: "error", message: "Filesystem is not connected." });
        return;
      }
      setState({ status: "loading" });
      try {
        const listing = await client.listDirectory(target, ".");
        setState({ status: "ready", entries: sortEntries(listing.entries) });
      } catch (error) {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Could not list this folder.",
        });
      }
    },
    [client],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setBrowseDirectory(directory);
    void load(directory);
  }, [directory, load, open]);

  const goUp = useCallback(() => {
    const parent = dirnamePath(browseDirectory);
    setBrowseDirectory(parent);
    void load(parent);
  }, [browseDirectory, load]);

  const enterDirectory = useCallback(
    (name: string) => {
      const next = joinAbsolutePath(browseDirectory, name);
      setBrowseDirectory(next);
      void load(next);
    },
    [browseDirectory, load],
  );

  const items: ReactElement[] = [];
  if (browseDirectory !== directory) {
    items.push(
      <DropdownMenuItem key="__up" closeOnSelect={false} onSelect={goUp}>
        ..
      </DropdownMenuItem>,
    );
  }
  if (state.status === "loading") {
    items.push(
      <DropdownMenuItem key="__loading" disabled>
        Loading…
      </DropdownMenuItem>,
    );
  } else if (state.status === "error") {
    items.push(
      <DropdownMenuItem key="__error" disabled>
        {state.message}
      </DropdownMenuItem>,
    );
  } else if (state.entries.length === 0) {
    items.push(
      <DropdownMenuItem key="__empty" disabled>
        Empty folder
      </DropdownMenuItem>,
    );
  } else {
    for (const entry of state.entries) {
      if (entry.kind === "directory") {
        items.push(
          <DropdownMenuItem
            key={`dir:${entry.path || entry.name}`}
            closeOnSelect={false}
            onSelect={() => enterDirectory(entry.name)}
          >
            {`${entry.name}/`}
          </DropdownMenuItem>,
        );
        continue;
      }
      const absolutePath = joinAbsolutePath(browseDirectory, entry.name);
      items.push(
        <DropdownMenuItem
          key={`file:${entry.path || entry.name}`}
          selected={pathsEqual(absolutePath, currentAbsolutePath)}
          onSelect={() => onOpenFile(toWorkspaceFileOpenPath(absolutePath, workspaceRoot))}
        >
          {entry.name}
        </DropdownMenuItem>,
      );
    }
  }

  return (
    <DropdownMenuContent
      align="start"
      width={300}
      maxHeight={360}
      testID="file-path-breadcrumb-menu"
    >
      <DropdownMenuLabel>{directoryLabel(browseDirectory)}</DropdownMenuLabel>
      {items}
    </DropdownMenuContent>
  );
}

function BreadcrumbSegment({
  segment,
  currentAbsolutePath,
  serverId,
  workspaceRoot,
  isLast,
  showSeparator,
  onOpenFile,
}: {
  segment: FileBreadcrumbSegment;
  currentAbsolutePath: string;
  serverId: string;
  workspaceRoot: string;
  isLast: boolean;
  showSeparator: boolean;
  onOpenFile: (openPath: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.segment}>
      {showSeparator ? <Text style={styles.separator}>›</Text> : null}
      <DropdownMenu onOpenChange={setOpen}>
        <DropdownMenuTrigger
          accessibilityRole="button"
          accessibilityLabel={
            isLast ? `Show siblings of ${segment.label}` : `Show files in ${segment.directory}`
          }
          style={({ hovered }) => [
            styles.trigger,
            hovered ? styles.triggerHovered : null,
            open ? styles.triggerOpen : null,
          ]}
        >
          <Text style={isLast ? styles.fileLabel : styles.directoryLabel} numberOfLines={1}>
            {segment.label}
          </Text>
        </DropdownMenuTrigger>
        <DirectoryMenu
          open={open}
          directory={segment.directory}
          currentAbsolutePath={currentAbsolutePath}
          serverId={serverId}
          workspaceRoot={workspaceRoot}
          onOpenFile={onOpenFile}
        />
      </DropdownMenu>
    </View>
  );
}

/**
 * Path strip above the file body. Every segment opens a dropdown of its own
 * directory, so sibling files are one click away (the file segment lists the
 * current file's siblings; parent segments list their own children).
 */
export function FilePathBreadcrumb({
  serverId,
  workspaceRoot,
  path,
  embedded = false,
  onOpenFile,
}: FilePathBreadcrumbProps) {
  const breadcrumb = useMemo(
    () => resolveFileBreadcrumb({ filePath: path, workspaceRoot }),
    [path, workspaceRoot],
  );
  if (!breadcrumb) {
    return null;
  }
  return (
    <View
      style={[styles.bar, embedded ? styles.barEmbedded : styles.barStandalone]}
      testID="file-path-breadcrumb"
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[
          styles.scrollContent,
          embedded ? styles.scrollContentEmbedded : null,
        ]}
        style={[styles.scroll, embedded ? styles.scrollEmbedded : null]}
      >
        {breadcrumb.segments.map((segment, index) => (
          <BreadcrumbSegment
            key={`${segment.directory}:${segment.label}`}
            segment={segment}
            currentAbsolutePath={breadcrumb.absolutePath}
            serverId={serverId}
            workspaceRoot={workspaceRoot}
            isLast={index === breadcrumb.segments.length - 1}
            showSeparator={index > 0}
            onOpenFile={onOpenFile}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  barStandalone: {
    flexShrink: 0,
  },
  barEmbedded: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
    borderBottomWidth: 0,
    backgroundColor: "transparent",
  },
  scroll: {
    maxHeight: 30,
  },
  scrollEmbedded: {
    flexGrow: 1,
    minWidth: 0,
  },
  scrollContent: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 3,
    gap: 1,
  },
  scrollContentEmbedded: {
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  segment: {
    flexDirection: "row",
    alignItems: "center",
  },
  separator: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: 2,
  },
  trigger: {
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 2,
    maxWidth: 260,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface1,
  },
  triggerOpen: {
    backgroundColor: theme.colors.surface1,
  },
  directoryLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  fileLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
}));
