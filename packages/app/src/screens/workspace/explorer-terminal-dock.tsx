import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ResizeHandle } from "@/components/resize-handle";
import { TerminalPane } from "@/components/terminal-pane";
import { useReplicaQuery } from "@/data/query";
import { workspaceTerminalsPushRoute } from "@/data/push-router";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { buildTerminalsQueryKey } from "@/screens/workspace/terminals/state";
import { useExplorerTerminalStore } from "@/screens/workspace/explorer-terminal-store";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";

const creatingShells = new Set<string>();
const noAction = () => {};

function terminalEmptyLabel(
  selected: "shell" | "script",
  creating: boolean,
  error: string | null,
  labels: { shellClosed: string; shellCreating: string; scriptStopped: string },
) {
  if (error) return error;
  if (selected === "script") return labels.scriptStopped;
  return creating ? labels.shellCreating : labels.shellClosed;
}

interface Props {
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
  isWorkspaceFocused: boolean;
  children: ReactNode;
  onOpenWorkspaceFile: (request: WorkspaceFileOpenRequest) => void;
}

function useShell(workspaceKey: string, serverId: string, workspaceId: string) {
  const directory = useWorkspaceDirectory(serverId, workspaceId);
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const saved = useExplorerTerminalStore((state) => state.byWorkspace[workspaceKey]);
  const update = useExplorerTerminalStore((state) => state.update);
  const setPending = useExplorerTerminalStore((state) => state.setPending);
  const [hydrated, setHydrated] = useState(() => useExplorerTerminalStore.persist.hasHydrated());
  useEffect(() => useExplorerTerminalStore.persist.onFinishHydration(() => setHydrated(true)), []);
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => buildTerminalsQueryKey(serverId, directory, workspaceId || null),
    [serverId, directory, workspaceId],
  );
  const enabled = Boolean(client && connected && directory);
  const terminalQuery = useReplicaQuery({
    queryKey,
    enabled,
    pushEvent: "terminals_changed",
    meta: workspaceTerminalsPushRoute({ enabled, serverId, cwd: directory ?? "", workspaceId }),
    queryFn: () => client!.listTerminals(directory!, undefined, { workspaceId }),
  });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createShell = useCallback(async () => {
    if (!client || !directory || creatingShells.has(workspaceKey)) return;
    creatingShells.add(workspaceKey);
    setPending(workspaceKey, true);
    setCreating(true);
    setError(null);
    try {
      const payload = await client.createTerminal(directory, undefined, undefined, { workspaceId });
      if (!payload.terminal) throw new Error(payload.error ?? "Unable to create shell");
      update(workspaceKey, { shellId: payload.terminal.id, selected: "shell" });
      await queryClient.invalidateQueries({ queryKey });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(workspaceKey, false);
      creatingShells.delete(workspaceKey);
      setCreating(false);
    }
  }, [client, directory, queryClient, queryKey, setPending, update, workspaceId, workspaceKey]);
  useEffect(() => {
    if (hydrated && terminalQuery.isSuccess && !saved?.shellId && !error) void createShell();
  }, [hydrated, terminalQuery.isSuccess, saved?.shellId, error, createShell]);

  return { directory, saved, update, terminalQuery, creating, error, createShell };
}

export function ExplorerTerminalDock({
  workspaceKey,
  serverId,
  workspaceId,
  isWorkspaceFocused,
  children,
  onOpenWorkspaceFile,
}: Props) {
  const { t } = useTranslation();
  const { directory, saved, update, terminalQuery, creating, error, createShell } = useShell(
    workspaceKey,
    serverId,
    workspaceId,
  );
  const [height, setHeight] = useState(0);
  const ratio = saved?.height ?? 0.35;
  const sizes = useMemo(() => [1 - ratio, ratio], [ratio]);
  const topStyle = useMemo(() => ({ flex: 1 - ratio, minHeight: 0 }), [ratio]);
  const bottomStyle = useMemo(() => [styles.bottom, { flex: ratio }], [ratio]);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setHeight(event.nativeEvent.layout.height),
    [],
  );
  const onResize = useCallback(
    (_groupId: string, next: number[]) => {
      update(workspaceKey, { height: Math.min(0.85, Math.max(0.15, next[1] ?? 0.35)) });
    },
    [update, workspaceKey],
  );
  const chooseShell = useCallback(
    () => update(workspaceKey, { selected: "shell" }),
    [update, workspaceKey],
  );
  const chooseScript = useCallback(
    () => update(workspaceKey, { selected: "script" }),
    [update, workspaceKey],
  );
  const liveIds = terminalQuery.data?.terminals.map((terminal) => terminal.id) ?? [];
  const shellId = saved?.shellId;
  const scriptId = saved?.scriptId;
  const selected = saved?.selected ?? "shell";
  const selectedId = selected === "script" ? scriptId : shellId;
  const terminalId = selectedId && liveIds.includes(selectedId) ? selectedId : null;
  const emptyLabel = terminalEmptyLabel(selected, creating, error, {
    shellClosed: t("workspace.scripts.states.shellClosed"),
    shellCreating: t("workspace.scripts.states.shellCreating"),
    scriptStopped: t("workspace.scripts.states.scriptStopped"),
  });
  const shellAccessibilityState = useMemo(() => ({ selected: selected === "shell" }), [selected]);
  const scriptAccessibilityState = useMemo(() => ({ selected: selected === "script" }), [selected]);

  return (
    <View style={styles.root} onLayout={onLayout}>
      <View style={topStyle}>{children}</View>
      <ResizeHandle
        testID="explorer-terminal-resize"
        direction="vertical"
        groupId="explorer-terminal"
        index={0}
        sizes={sizes}
        containerSize={height}
        onPreviewResizeSplit={onResize}
        onResizeSplit={onResize}
      />
      <View style={bottomStyle}>
        <View style={styles.tabs}>
          <Pressable
            accessibilityRole="tab"
            accessibilityState={shellAccessibilityState}
            testID="explorer-shell-tab"
            onPress={chooseShell}
            style={[styles.tab, selected === "shell" && styles.selectedTab]}
          >
            <Text style={styles.tabText}>Shell</Text>
          </Pressable>
          {scriptId ? (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={scriptAccessibilityState}
              testID="explorer-script-tab"
              onPress={chooseScript}
              style={[styles.tab, selected === "script" && styles.selectedTab]}
            >
              <Text style={styles.tabText}>Script</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.content}>
          {terminalId && directory ? (
            <TerminalPane
              key={terminalId}
              serverId={serverId}
              cwd={directory}
              terminalId={terminalId}
              isWorkspaceFocused={isWorkspaceFocused}
              isPaneFocused
              autoFocus={false}
              onOpenFileExplorer={noAction}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
            />
          ) : (
            <Pressable
              onPress={selected === "shell" ? createShell : undefined}
              disabled={creating || selected === "script"}
              style={styles.empty}
            >
              <Text style={styles.emptyText}>{emptyLabel}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  bottom: {
    minHeight: 0,
    backgroundColor: theme.colors.surfaceWorkspace,
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  tabs: {
    height: 32,
    flexDirection: "row",
    alignItems: "stretch",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  tab: { paddingHorizontal: theme.spacing[3], justifyContent: "center" },
  selectedTab: { borderBottomWidth: 2, borderBottomColor: theme.colors.accent },
  tabText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  content: { flex: 1, minHeight: 0 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
