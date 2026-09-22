import type { AgentArtifact } from "@getpaseo/protocol/agent-types";
import { isCompanionEntryPending, type CompanionEntry } from "@getpaseo/protocol/companion-stream";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Text, View, TextInput } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ArtifactCard, ArtifactFeed } from "@/artifacts/feed";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useHostRuntimeConnectionStatus, useHostRuntimeClient } from "@/runtime/host-runtime";
import { formatMessageTimestamp } from "@/utils/time";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import { buildCompanionFeed, type CompanionFeedItem } from "./model";

interface CompanionFeedProps {
  serverId: string;
  agentId: string;
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

type ViewTab = "stream" | "pinned";
type StreamFilter = "all" | "question" | "feature_request" | "permission" | "outcome";

export function CompanionFeed({
  serverId,
  agentId,
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
  const client = useHostRuntimeClient(serverId);
  
  const [viewTab, setViewTab] = useState<ViewTab>("stream");
  const [filter, setFilter] = useState<StreamFilter>("all");
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [pinText, setPinText] = useState("");

  const items = useMemo(() => buildCompanionFeed(entries, artifacts), [entries, artifacts]);

  const visible = useMemo(() => {
    return items.filter((item) => {
      if (viewTab === "pinned") {
        return item.kind === "entry" && item.entry.kind === "pin";
      } else {
        // Stream / Queue
        if (item.kind === "entry" && item.entry.kind === "pin") return false;

        if (item.kind === "artifact") {
          return filter === "all" && !onlyOpen; 
        }
        
        if (filter !== "all" && item.entry.kind !== filter) return false;

        if (onlyOpen) {
          if (item.entry.kind === "question" || item.entry.kind === "feature_request") {
            return item.entry.status === "open";
          }
          if (item.entry.kind === "permission") {
            return item.entry.status === "pending";
          }
          return false;
        }

        return true;
      }
    });
  }, [items, viewTab, filter, onlyOpen]);

  const openArtifact = useCallback(
    (artifact: AgentArtifact) => {
      onOpenWorkspaceFile?.({ location: { path: artifact.path }, disposition: "side" });
      onReturnToChat();
    },
    [onOpenWorkspaceFile, onReturnToChat],
  );

  const handleUpdateStatus = useCallback((entryId: string, status: "open" | "reviewed" | "done") => {
    client?.updateCompanionEntry({ agentId, entryId, action: "update_status", status }).catch(() => {});
  }, [client, agentId]);

  const handleRemovePin = useCallback((entryId: string) => {
    client?.updateCompanionEntry({ agentId, entryId, action: "remove_pin" }).catch(() => {});
  }, [client, agentId]);

  const renderItem = useCallback(
    ({ item }: { item: CompanionFeedItem }) =>
      item.kind === "artifact" ? (
        <ArtifactCard
          artifact={item.artifact}
          serverId={serverId}
          cwd={cwd}
          onOpen={openArtifact}
          onPin={() => {
            client?.updateCompanionEntry({ 
              agentId, 
              action: "add_pin", 
              text: `Artifact: ${item.artifact.path}`,
              sourceId: `artifact:${item.artifact.path}` 
            }).catch(() => {});
          }}
        />
      ) : (
        <EntryCard
          entry={item.entry}
          onReturnToChat={onReturnToChat}
          onReplyInChat={onReplyInChat}
          onUpdateStatus={handleUpdateStatus}
          onRemovePin={handleRemovePin}
        />
      ),
    [serverId, cwd, openArtifact, onReturnToChat, onReplyInChat, handleUpdateStatus, handleRemovePin],
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

        <SegmentedControl
          value={viewTab}
          onValueChange={setViewTab}
          options={[
            { value: "stream", label: "Queue" },
            { value: "pinned", label: "Pinned" },
          ]}
        />

        {viewTab === "stream" && (
          <View style={{ gap: 8, marginTop: 8 }}>
            <SegmentedControl
              value={filter}
              onValueChange={setFilter}
              size="sm"
              options={[
                { value: "all", label: "All" },
                { value: "question", label: "Questions" },
                { value: "feature_request", label: "Features" },
                { value: "permission", label: "Decisions" },
                { value: "outcome", label: "Outcomes" },
              ]}
            />
            <Button
              variant={onlyOpen ? "secondary" : "outline"}
              style={styles.touchTarget}
              onPress={() => setOnlyOpen((v) => !v)}
              testID="companion-stream-pending"
            >
              {onlyOpen ? "Show All" : "Show Open Only"}
            </Button>
          </View>
        )}

        {viewTab === "pinned" && (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <TextInput
              style={{ flex: 1, borderWidth: 1, borderColor: '#444', padding: 8, borderRadius: 8, color: '#fff' }}
              placeholder="Type a note or link..."
              placeholderTextColor="#888"
              value={pinText}
              onChangeText={setPinText}
              onSubmitEditing={() => {
                if (!pinText.trim()) return;
                client?.updateCompanionEntry({ agentId, action: "add_pin", text: pinText.trim() });
                setPinText("");
              }}
            />
            <Button
              onPress={() => {
                if (!pinText.trim()) return;
                client?.updateCompanionEntry({ agentId, action: "add_pin", text: pinText.trim() });
                setPinText("");
              }}
            >
              Add Note
            </Button>
          </View>
        )}
      </View>
    ),
    [connection, viewTab, filter, onlyOpen, pinText, client, agentId, t],
  );

  const empty = useMemo(
    () => (
      <View style={styles.empty} testID="companion-stream-empty">
        <Text style={styles.title}>
          {viewTab === "pinned" ? "No pinned items" : "No items found"}
        </Text>
        <Button variant="outline" style={styles.touchTarget} onPress={onReturnToChat}>
          {t("agentPanel.stream.backToChat")}
        </Button>
      </View>
    ),
    [viewTab, onReturnToChat, t],
  );

  const hasItems = visible.length > 0;
  const footer = useMemo(
    () =>
      hasItems && viewTab === "stream" ? (
        <View style={styles.footer}>
          <Text style={styles.description}>{t("agentPanel.stream.outcomeDescription")}</Text>
          <Text style={styles.description}>{t("agentPanel.stream.retention")}</Text>
        </View>
      ) : null,
    [hasItems, viewTab, t],
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
  onUpdateStatus,
  onRemovePin,
}: {
  entry: CompanionEntry;
  onReturnToChat: () => void;
  onReplyInChat: () => void;
  onUpdateStatus: (id: string, status: "open" | "reviewed" | "done") => void;
  onRemovePin: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const pending = isCompanionEntryPending(entry);
  const expandedAccessibilityState = useMemo(() => ({ expanded }), [expanded]);
  
  let title: string;
  let status: string = "";
  if (entry.kind === "question") {
    title = t("agentPanel.stream.question");
    status = entry.status;
  } else if (entry.kind === "feature_request") {
    title = "Feature Request";
    status = entry.status;
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
  } else if (entry.kind === "pin") {
    title = "Pinned Note";
  } else {
    title = t(`agentPanel.stream.${entry.status}`);
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
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={styles.eyebrow}>{formatMessageTimestamp(new Date(entry.timestamp))}</Text>
        {entry.kind === "pin" ? (
           <Button variant="ghost" size="icon" onPress={() => onRemovePin(entry.id)}>
             <Text style={styles.description}>Unpin</Text>
           </Button>
        ) : null}
      </View>
      
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
        
        {(entry.kind === "question" || entry.kind === "feature_request") && (
          <View style={{ flexDirection: "row", gap: 8, marginTop: 8, width: "100%" }}>
            <Button variant="outline" onPress={() => onUpdateStatus(entry.id, "open")}>Open</Button>
            <Button variant="outline" onPress={() => onUpdateStatus(entry.id, "reviewed")}>Reviewed</Button>
            <Button variant="outline" onPress={() => onUpdateStatus(entry.id, "done")}>Done</Button>
          </View>
        )}
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
