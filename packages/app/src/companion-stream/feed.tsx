import type { AgentArtifact } from "@getpaseo/protocol/agent-types";
import { isCompanionEntryPending, type CompanionEntry } from "@getpaseo/protocol/companion-stream";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ArtifactCard, ArtifactFeed } from "@/artifacts/feed";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { useHostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import { formatMessageTimestamp } from "@/utils/time";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import { buildCompanionFeed, type CompanionFeedItem } from "./model";

interface CompanionFeedProps {
  serverId: string;
  cwd: string;
  entries: readonly CompanionEntry[];
  artifacts: readonly AgentArtifact[];
  isSupported: boolean;
  artifactsSupported: boolean;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
  onReturnToChat: () => void;
  onReplyInChat: () => void;
}

const keyExtractor = (item: CompanionFeedItem) => item.id;

export function CompanionFeed({
  serverId,
  cwd,
  entries,
  artifacts,
  isSupported,
  artifactsSupported,
  onOpenWorkspaceFile,
  onReturnToChat,
  onReplyInChat,
}: CompanionFeedProps) {
  const { t } = useTranslation();
  const connection = useHostRuntimeConnectionStatus(serverId);
  const [onlyPending, setOnlyPending] = useState(false);
  const items = useMemo(() => buildCompanionFeed(entries, artifacts), [entries, artifacts]);
  const pendingCount = entries.filter(isCompanionEntryPending).length;
  const visible = useMemo(
    () =>
      onlyPending
        ? items.filter((item) => item.kind === "entry" && isCompanionEntryPending(item.entry))
        : items,
    [items, onlyPending],
  );
  const pendingAccessibilityState = useMemo(() => ({ selected: onlyPending }), [onlyPending]);
  const togglePending = useCallback(() => setOnlyPending((value) => !value), []);
  const openArtifact = useCallback(
    (artifact: AgentArtifact) => {
      onOpenWorkspaceFile?.({ location: { path: artifact.path }, disposition: "side" });
      onReturnToChat();
    },
    [onOpenWorkspaceFile, onReturnToChat],
  );
  const renderItem = useCallback(
    ({ item }: { item: CompanionFeedItem }) =>
      item.kind === "artifact" ? (
        <ArtifactCard
          artifact={item.artifact}
          serverId={serverId}
          cwd={cwd}
          onOpen={openArtifact}
        />
      ) : (
        <EntryCard
          entry={item.entry}
          onReturnToChat={onReturnToChat}
          onReplyInChat={onReplyInChat}
        />
      ),
    [serverId, cwd, openArtifact, onReturnToChat, onReplyInChat],
  );

  const header = useMemo(
    () => (
      <View style={styles.header}>
        <Text style={styles.title}>{t("agentPanel.stream.title")}</Text>
        <Text style={styles.description}>{t("agentPanel.stream.description")}</Text>
        {connection !== "online" ? (
          <View style={styles.notice} testID="companion-stream-connection">
            {connection === "connecting" ? <ActivityIndicator size="small" /> : null}
            <Text style={styles.description}>{t("agentPanel.stream.offline")}</Text>
          </View>
        ) : null}
        <Button
          variant={onlyPending ? "secondary" : "outline"}
          style={styles.touchTarget}
          onPress={togglePending}
          accessibilityState={pendingAccessibilityState}
          testID="companion-stream-pending"
        >
          {onlyPending
            ? t("agentPanel.stream.showAll")
            : t("agentPanel.stream.pending", { count: pendingCount })}
        </Button>
      </View>
    ),
    [connection, onlyPending, pendingCount, pendingAccessibilityState, togglePending, t],
  );
  const empty = useMemo(
    () => (
      <View style={styles.empty} testID="companion-stream-empty">
        <Text style={styles.title}>
          {t(onlyPending ? "agentPanel.stream.noPending" : "agentPanel.stream.emptyTitle")}
        </Text>
        <Text style={styles.description}>
          {t(
            onlyPending
              ? "agentPanel.stream.noPendingDescription"
              : "agentPanel.stream.emptyDescription",
          )}
        </Text>
        <Button variant="outline" style={styles.touchTarget} onPress={onReturnToChat}>
          {t("agentPanel.stream.backToChat")}
        </Button>
      </View>
    ),
    [onlyPending, onReturnToChat, t],
  );
  const hasItems = visible.length > 0;
  const footer = useMemo(
    () =>
      hasItems ? (
        <View style={styles.footer}>
          <Text style={styles.description}>{t("agentPanel.stream.outcomeDescription")}</Text>
          <Text style={styles.description}>{t("agentPanel.stream.retention")}</Text>
        </View>
      ) : null,
    [hasItems, t],
  );

  if (!isSupported) {
    return (
      <View style={styles.root}>
        <View style={styles.notice} testID="companion-stream-unsupported">
          <Text style={styles.title}>{t("agentPanel.stream.updateHost")}</Text>
          <Text style={styles.description}>{t("agentPanel.stream.updateHostDescription")}</Text>
        </View>
        <ArtifactFeed
          serverId={serverId}
          cwd={cwd}
          artifacts={artifacts}
          isSupported={artifactsSupported}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          onReturnToChat={onReturnToChat}
        />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.root}
      contentContainerStyle={styles.feed}
      testID="companion-stream"
      data={visible}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      ItemSeparatorComponent={CardSeparator}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
    />
  );
}

function CardSeparator() {
  return <View style={styles.separator} />;
}

function EntryCard({
  entry,
  onReturnToChat,
  onReplyInChat,
}: {
  entry: CompanionEntry;
  onReturnToChat: () => void;
  onReplyInChat: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const pending = isCompanionEntryPending(entry);
  const expandedAccessibilityState = useMemo(() => ({ expanded }), [expanded]);
  let title: string;
  let status: string;
  if (entry.kind === "question") {
    title = t("agentPanel.stream.question");
    status = t(`agentPanel.stream.${entry.status}`);
  } else if (entry.kind === "permission") {
    const titles = {
      question: "question",
      plan: "decision",
      tool: "permission",
      mode: "permission",
      other: "permission",
    } as const;
    title = t(`agentPanel.stream.${titles[entry.requestKind]}`);
    status = t(
      entry.status === "pending"
        ? "agentPanel.stream.pendingStatus"
        : `agentPanel.stream.${entry.status}`,
    );
  } else {
    title = t(`agentPanel.stream.${entry.status}`);
    status = "";
  }
  let body = null;
  if (entry.text) {
    body = expanded ? (
      <MarkdownRenderer text={entry.text} compact enableHtmlish={false} />
    ) : (
      <Text selectable style={styles.body} numberOfLines={6}>
        {entry.text}
      </Text>
    );
  }
  return (
    <View
      style={[styles.card, pending && styles.pendingCard]}
      testID={`companion-entry-${entry.id}`}
    >
      <Text style={styles.eyebrow}>{formatMessageTimestamp(new Date(entry.timestamp))}</Text>
      <Text style={styles.title}>{title}</Text>
      {status ? (
        <Text style={[styles.description, pending && styles.pendingText]}>{status}</Text>
      ) : null}
      {body}
      {entry.truncated ? (
        <Text style={styles.description}>{t("agentPanel.stream.excerpt")}</Text>
      ) : null}
      <View style={styles.actions}>
        {entry.text ? (
          <Button
            variant="ghost"
            style={styles.touchTarget}
            onPress={toggleExpanded}
            accessibilityState={expandedAccessibilityState}
          >
            {t(expanded ? "agentPanel.stream.showLess" : "agentPanel.stream.read")}
          </Button>
        ) : null}
        <Button
          variant={pending ? "secondary" : "outline"}
          style={styles.touchTarget}
          onPress={pending ? onReplyInChat : onReturnToChat}
        >
          {t(pending ? "agentPanel.stream.replyInChat" : "agentPanel.stream.backToChat")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface0 },
  feed: { width: "100%", maxWidth: 760, alignSelf: "center", padding: theme.spacing[4] },
  header: { gap: theme.spacing[2], paddingBottom: theme.spacing[6] },
  notice: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  eyebrow: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.xs },
  card: {
    padding: theme.spacing[4],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[2],
  },
  pendingCard: { borderLeftWidth: 3, borderLeftColor: theme.colors.accent },
  pendingText: { color: theme.colors.accent },
  body: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 22,
    marginTop: theme.spacing[2],
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  touchTarget: { minHeight: 44 },
  empty: { gap: theme.spacing[3], paddingVertical: theme.spacing[6] },
  separator: { height: theme.spacing[3] },
  footer: {
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[6],
  },
}));
