import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { useIndexing, type IndexingWorkspaceEntry } from "@/hooks/use-indexing";

const AUTO_HIDE_IDLE_MS = 3_000;

type VisibleStatus = {
  label: string;
  detail: string | null;
  progress: number | null;
};

function pickStatus(entries: IndexingWorkspaceEntry[]): VisibleStatus | null {
  // Surface the most-interesting active phase across all enabled workspaces.
  // Priority: installing > indexing > error; otherwise return null (idle).
  const prioritized = entries
    .filter((e) => e.indexing && e.indexing.enabled)
    .map((e) => e.indexing as NonNullable<typeof e.indexing>);
  const installing = prioritized.find((s) => s.status.phase === "installing");
  if (installing) {
    return {
      label: "Installing code-review-graph…",
      detail: null,
      progress: installing.status.progress ?? null,
    };
  }
  const indexing = prioritized.find((s) => s.status.phase === "indexing");
  if (indexing) {
    const progress = indexing.status.progress ?? null;
    const fileLabel =
      indexing.status.fileCount != null ? ` — ${indexing.status.fileCount} files` : "";
    return {
      label: "Indexing…",
      detail: fileLabel || null,
      progress,
    };
  }
  const errored = prioritized.find((s) => s.status.phase === "error");
  if (errored) {
    return {
      label: "Indexing error",
      detail: errored.status.error ?? null,
      progress: null,
    };
  }
  return null;
}

/**
 * Banner that surfaces active indexing operations (install + index progress)
 * across all workspaces on the given serverId. Renders inline: the parent
 * decides where it lands. Returns null when there's nothing to say (idle),
 * auto-hiding 3s after the last active event.
 */
export function IndexingStatusBar({ serverId }: { serverId: string | null }) {
  const { theme } = useUnistyles();
  const indexing = useIndexing(serverId);
  const active = useMemo(() => pickStatus(indexing.entries), [indexing.entries]);

  // Subprocess health is surfaced only when it's NOT healthy (running = quiet).
  // `restarting` / `failed` / `stopped` with errors all deserve visibility;
  // `starting` is noisy during boot so we suppress it unless it lingers.
  const processState = indexing.processState;
  const processAlert =
    processState &&
    (processState.phase === "restarting" ||
      processState.phase === "failed" ||
      (processState.phase === "stopped" && processState.restartCount > 0))
      ? processState
      : null;

  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (active || processAlert) {
      setVisible(true);
      return;
    }
    const handle = setTimeout(() => setVisible(false), AUTO_HIDE_IDLE_MS);
    return () => clearTimeout(handle);
  }, [active, processAlert]);

  if (!visible || !serverId || !indexing.isConnected) return null;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        marginBottom: 12,
      }}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: theme.colors.foreground,
        }}
      />
      <Text style={{ color: theme.colors.foreground, fontSize: 13, flexShrink: 1 }}>
        {active?.label ?? (processAlert ? describeProcessAlert(processAlert) : "Idle")}
        {active?.detail ? (
          <Text style={{ color: theme.colors.foregroundMuted }}>{active.detail}</Text>
        ) : null}
        {active?.progress != null ? (
          <Text style={{ color: theme.colors.foregroundMuted }}>
            {" "}
            — {Math.round(active.progress)}%
          </Text>
        ) : null}
        {!active && processAlert ? (
          <Text style={{ color: theme.colors.foregroundMuted }}>
            {processAlert.restartCount > 0 ? ` (${processAlert.restartCount} restarts)` : ""}
            {processAlert.lastError ? ` — ${processAlert.lastError}` : ""}
          </Text>
        ) : null}
      </Text>
    </View>
  );
}

function describeProcessAlert(state: {
  phase: "stopped" | "starting" | "running" | "restarting" | "failed";
}): string {
  switch (state.phase) {
    case "restarting":
      return "code-review-graph restarting…";
    case "failed":
      return "code-review-graph failed";
    case "stopped":
      return "code-review-graph stopped";
    default:
      return "code-review-graph";
  }
}
