import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  Camera,
  ChevronDown,
  ChevronRight,
  FileText,
  MessageSquare,
  RefreshCw,
} from "@/components/icons/ui-icons";
import { useTranslation } from "react-i18next";
import type {
  EvidenceArtifactSummary,
  EvidenceRunSummary,
} from "@getpaseo/protocol/verify/rpc-schemas";
import { AttachmentLightbox } from "@/components/attachment-lightbox";
import { usePaneContext } from "@/panels/pane-context";
import { getHostRuntimeStore, useHostRuntimeClient } from "@/runtime/host-runtime";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import { formatTimeAgo } from "@/utils/time";

export function useEvidenceRuns(input: {
  serverId: string;
  workspaceId: string;
  enabled?: boolean;
}): {
  runs: EvidenceRunSummary[] | null;
  failed: boolean;
  refresh: () => void;
} {
  const client = useHostRuntimeClient(input.serverId);
  const [runs, setRuns] = useState<EvidenceRunSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (input.enabled === false || !client) {
      return;
    }
    let cancelled = false;
    setFailed(false);
    const load = async (): Promise<void> => {
      try {
        const payload = await client.listEvidenceRuns(input.workspaceId);
        if (cancelled) {
          return;
        }
        if (payload.error) {
          setFailed(true);
          return;
        }
        setRuns(payload.runs);
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, input.enabled, input.workspaceId, revision]);

  const refresh = useCallback(() => {
    setRuns(null);
    setFailed(false);
    setRevision((current) => current + 1);
  }, []);

  return { runs, failed, refresh };
}

export function runStatusStyle(status: EvidenceRunSummary["status"]) {
  if (status === "pass") {
    return styles.statusPass;
  }
  if (status === undefined) {
    return styles.statusRunning;
  }
  return styles.statusFail;
}

function formatArtifactSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function formatCaptureTime(iso: string | undefined): string | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return formatTimeAgo(date);
}

interface SelectedArtifact {
  key: string;
  uri: string;
}

export function EvidenceContent(input: { serverId: string; workspaceId: string }) {
  const { t } = useTranslation();
  const { openTab } = usePaneContext();
  const client = useHostRuntimeClient(input.serverId);
  const { runs, failed, refresh } = useEvidenceRuns({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<SelectedArtifact | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const lightboxSource = useMemo(
    () => (selected ? { type: "uri" as const, uri: selected.uri } : null),
    [selected],
  );
  const handleCloseLightbox = useCallback(() => setSelected(null), []);

  const toggleRun = useCallback((runId: string) => {
    setExpandedRuns((current) => {
      const next = new Set(current);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  }, []);

  const openArtifact = useCallback(
    async (run: EvidenceRunSummary, artifact: EvidenceArtifactSummary) => {
      if (!client || artifact.kind !== "screenshot") {
        return;
      }
      const key = `${run.runId}/${artifact.name}`;
      setLoadingKey(key);
      try {
        const payload = await client.getEvidenceArtifact(
          input.workspaceId,
          run.runId,
          artifact.name,
        );
        if (!payload.error && payload.dataBase64) {
          setSelected({
            key,
            uri: `data:${artifact.contentType};base64,${payload.dataBase64}`,
          });
        }
      } finally {
        setLoadingKey(null);
      }
    },
    [client, input.workspaceId],
  );

  const showInChat = useCallback(
    async (run: EvidenceRunSummary, artifact: EvidenceArtifactSummary) => {
      if (!run.agentId || !artifact.timelineCursor) {
        return;
      }
      openTab({ kind: "agent", agentId: run.agentId });
      try {
        await getHostRuntimeStore().fetchAgentTimeline(
          input.serverId,
          run.agentId,
          planTimelinePromptJump(artifact.timelineCursor),
        );
      } catch {
        // The agent tab is open; the referenced window simply stays unloaded.
      }
    },
    [input.serverId, openTab],
  );

  if (failed) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{t("panels.evidence.loadFailed")}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={refresh}
          testID="evidence-retry"
          style={styles.retryButton}
        >
          <Text style={styles.retryLabel}>{t("common.actions.retry")}</Text>
        </Pressable>
      </View>
    );
  }

  if (!runs) {
    return (
      <View style={styles.centered}>
        <Text style={styles.mutedText}>{t("common.loading")}</Text>
      </View>
    );
  }

  if (runs.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyTitle}>{t("panels.evidence.emptyTitle")}</Text>
        <Text style={styles.mutedText}>{t("panels.evidence.emptyDescription")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.list}>
      <View style={styles.listHeader}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("panels.evidence.label")}
          onPress={refresh}
          testID="evidence-refresh"
          style={styles.iconButton}
        >
          <RefreshCw size={16} color={styles.icon.color} />
        </Pressable>
      </View>
      {runs.map((run) => (
        <EvidenceRunFolder
          key={run.runId}
          run={run}
          expanded={expandedRuns.has(run.runId)}
          loadingKey={loadingKey}
          showInChatLabel={t("panels.evidence.showInChat")}
          onToggle={toggleRun}
          onOpenArtifact={openArtifact}
          onShowInChat={showInChat}
        />
      ))}
      <AttachmentLightbox source={lightboxSource} onClose={handleCloseLightbox} />
    </View>
  );
}

function EvidenceRunFolder(input: {
  run: EvidenceRunSummary;
  expanded: boolean;
  loadingKey: string | null;
  showInChatLabel: string;
  onToggle: (runId: string) => void;
  onOpenArtifact: (run: EvidenceRunSummary, artifact: EvidenceArtifactSummary) => void;
  onShowInChat: (run: EvidenceRunSummary, artifact: EvidenceArtifactSummary) => void;
}) {
  const handleToggle = useCallback(() => input.onToggle(input.run.runId), [input]);
  return (
    <View style={styles.runFolder}>
      <Pressable
        accessibilityRole="button"
        onPress={handleToggle}
        testID={`evidence-run-${input.run.runId}`}
        style={styles.runHeader}
      >
        <View style={[styles.statusDot, runStatusStyle(input.run.status)]} />
        <View style={styles.runTitle}>
          <Text style={styles.runName} numberOfLines={1}>
            #{input.run.seq} {input.run.recipe}
          </Text>
          <Text style={styles.mutedText} numberOfLines={1}>
            {formatTimeAgo(new Date(input.run.startedAt))}
          </Text>
        </View>
        {input.expanded ? (
          <ChevronDown size={16} color={styles.icon.color} />
        ) : (
          <ChevronRight size={16} color={styles.icon.color} />
        )}
      </Pressable>
      {input.expanded
        ? (input.run.artifacts ?? []).map((artifact) => (
            <EvidenceArtifactRow
              key={artifact.name}
              run={input.run}
              artifact={artifact}
              loading={input.loadingKey === `${input.run.runId}/${artifact.name}`}
              showInChatLabel={input.showInChatLabel}
              onOpenArtifact={input.onOpenArtifact}
              onShowInChat={input.onShowInChat}
            />
          ))
        : null}
    </View>
  );
}

function EvidenceArtifactRow(input: {
  run: EvidenceRunSummary;
  artifact: EvidenceArtifactSummary;
  loading: boolean;
  showInChatLabel: string;
  onOpenArtifact: (run: EvidenceRunSummary, artifact: EvidenceArtifactSummary) => void;
  onShowInChat: (run: EvidenceRunSummary, artifact: EvidenceArtifactSummary) => void;
}) {
  const handleOpen = useCallback(() => input.onOpenArtifact(input.run, input.artifact), [input]);
  const handleShowInChat = useCallback(
    () => input.onShowInChat(input.run, input.artifact),
    [input],
  );
  const isImage = input.artifact.kind === "screenshot";
  const captured = formatCaptureTime(input.artifact.capturedAt);
  const canAnchor = Boolean(input.run.agentId && input.artifact.timelineCursor);
  const row = (
    <View style={styles.artifactRow}>
      {isImage ? (
        <Camera size={16} color={styles.icon.color} />
      ) : (
        <FileText size={16} color={styles.icon.color} />
      )}
      <View style={styles.artifactTitle}>
        <Text style={styles.artifactName} numberOfLines={1}>
          {input.artifact.name}
          {input.loading ? " …" : ""}
        </Text>
        <Text style={styles.mutedText} numberOfLines={1}>
          {[captured, formatArtifactSize(input.artifact.bytes)].filter(Boolean).join(" · ")}
        </Text>
      </View>
      {canAnchor ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={input.showInChatLabel}
          onPress={handleShowInChat}
          testID={`evidence-anchor-${input.run.runId}-${input.artifact.name}`}
          style={styles.iconButton}
        >
          <MessageSquare size={16} color={styles.icon.color} />
        </Pressable>
      ) : null}
    </View>
  );
  if (!isImage) {
    return row;
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={handleOpen}
      testID={`evidence-open-${input.run.runId}-${input.artifact.name}`}
    >
      {row}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    flex: 1,
    padding: 12,
    gap: 8,
  },
  listHeader: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 8,
  },
  runFolder: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    overflow: "hidden",
  },
  runHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 10,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusPass: {
    backgroundColor: theme.colors.success,
  },
  statusFail: {
    backgroundColor: theme.colors.destructive,
  },
  statusRunning: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  runTitle: {
    flex: 1,
    gap: 2,
  },
  runName: {
    color: theme.colors.foreground,
    fontSize: 14,
    fontWeight: "600",
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: 12,
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: 15,
    fontWeight: "600",
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: 14,
  },
  retryButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
  },
  retryLabel: {
    color: theme.colors.foreground,
    fontSize: 14,
  },
  artifactRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  artifactTitle: {
    flex: 1,
    gap: 2,
  },
  artifactName: {
    color: theme.colors.foreground,
    fontSize: 13,
  },
  iconButton: {
    padding: 4,
  },
  icon: {
    color: theme.colors.foregroundMuted,
  },
}));
