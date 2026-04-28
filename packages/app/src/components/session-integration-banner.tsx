// SessionIntegrationBanner — shows linked integration issues in agent/terminal sessions
// Displays a compact, collapsible banner at the top of the session view

import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react-native";
import { useSessionStore } from "@/stores/session-store";
import type { TaskMetadata } from "@/types/integrations";
import {
  IntegrationIcon,
  integrationDisplayName,
  extractLinkedIntegrations,
  mergeLinkedIntegrationWithRawIssue,
  type LinkedIntegration,
} from "@/components/kanban/integration-context";
import { useIntegrationSearch } from "@/hooks/use-integration-status";
import { openExternalUrl } from "@/utils/open-external-url";
import { buildTaskAgentPrompt } from "@/lib/task-agent-prompt";
import { Send } from "lucide-react-native";

interface SessionIntegrationBannerProps {
  serverId?: string;
  cwd?: string | null;
  /** Called when user wants to inject issue context as prompt */
  onSendToAgent?: (prompt: string) => void;
}

export function SessionIntegrationBanner({
  serverId,
  cwd,
  onSendToAgent,
}: SessionIntegrationBannerProps) {
  const workspace = useSessionStore((state) => {
    if (!serverId || !cwd) return null;
    return state.sessions[serverId]?.workspaces?.get(cwd) ?? null;
  });
  const integrations = useMemo(
    () =>
      extractLinkedIntegrations(
        workspace?.issueMetadata as TaskMetadata | undefined,
        workspace?.issueContext,
        workspace?.name,
        workspace?.prompt,
      ),
    [workspace?.issueContext, workspace?.issueMetadata, workspace?.name, workspace?.prompt],
  );

  const { theme } = useUnistyles();

  const handleSendToAgent = useCallback(() => {
    if (!onSendToAgent || !workspace) return;
    const prompt = buildTaskAgentPrompt({
      metadata: workspace.issueMetadata as TaskMetadata | undefined,
    });
    if (prompt) {
      onSendToAgent(prompt);
    }
  }, [onSendToAgent, workspace]);

  if (integrations.length === 0) return null;

  return (
    <View style={styles.container}>
      {integrations.map((item) => (
        <IntegrationBannerItem
          key={item.id}
          item={item}
          serverId={serverId}
          cwd={cwd ?? undefined}
          onSendToAgent={onSendToAgent ? handleSendToAgent : undefined}
        />
      ))}
    </View>
  );
}

function IntegrationBannerItem({
  item,
  serverId,
  cwd,
  onSendToAgent,
}: {
  item: LinkedIntegration;
  serverId?: string;
  cwd?: string;
  onSendToAgent?: () => void;
}) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(false);
  const [resolvedItem, setResolvedItem] = useState(item);
  const searchMutation = useIntegrationSearch(serverId);

  useEffect(() => {
    setResolvedItem(item);
  }, [item]);

  useEffect(() => {
    if (!expanded || !serverId || (resolvedItem.url && resolvedItem.description)) {
      return;
    }
    let cancelled = false;
    const query = resolvedItem.identifier.replace(/^#/, "").trim() || resolvedItem.title.trim();
    if (!query) {
      return;
    }
    void searchMutation
      .mutateAsync({
        integrationId: resolvedItem.id,
        query,
        cwd: cwd?.trim() || undefined,
        limit: 5,
      })
      .then((result) => {
        if (cancelled || !result.items?.length) {
          return;
        }
        const raw = result.items[0];
        if (!raw || typeof raw !== "object") {
          return;
        }
        setResolvedItem((prev) => mergeLinkedIntegrationWithRawIssue(prev, raw));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- searchMutation is a new object each render; including it causes infinite loops
  }, [
    cwd,
    expanded,
    resolvedItem.description,
    resolvedItem.id,
    resolvedItem.identifier,
    resolvedItem.title,
    resolvedItem.url,
    serverId,
  ]);

  return (
    <View style={styles.item}>
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={() => setExpanded((v) => !v)}
      >
        <IntegrationIcon integration={resolvedItem.id} size={14} color={theme.colors.foreground} />
        <Text style={styles.identifier}>{resolvedItem.identifier}</Text>
        <Text style={styles.title} numberOfLines={1}>
          {resolvedItem.title}
        </Text>
        <View style={styles.actions}>
          {onSendToAgent ? (
            <Pressable
              onPress={(e) => {
                e.stopPropagation?.();
                onSendToAgent();
              }}
              hitSlop={6}
              style={({ pressed }) => [styles.sendButton, pressed && styles.sendButtonPressed]}
            >
              <Send size={11} color={theme.colors.foreground} />
              <Text style={styles.sendButtonText}>Use as prompt</Text>
            </Pressable>
          ) : null}
          {resolvedItem.url ? (
            <Pressable
              onPress={(e) => {
                e.stopPropagation?.();
                if (resolvedItem.url) void openExternalUrl(resolvedItem.url);
              }}
              hitSlop={6}
              style={({ pressed }) => [styles.openButton, pressed && styles.openButtonPressed]}
            >
              <ExternalLink size={11} color={theme.colors.foreground} />
              <Text style={styles.openButtonText}>
                Open in {integrationDisplayName(resolvedItem.id)}
              </Text>
            </Pressable>
          ) : null}
          {expanded ? (
            <ChevronUp size={12} color={theme.colors.foregroundMuted} />
          ) : (
            <ChevronDown size={12} color={theme.colors.foregroundMuted} />
          )}
        </View>
      </Pressable>

      {expanded ? (
        <View style={styles.detail}>
          {resolvedItem.description ? (
            <Text style={styles.description} numberOfLines={4}>
              {resolvedItem.description}
            </Text>
          ) : null}
          {resolvedItem.meta.length > 0 ? (
            <Text style={styles.meta}>{resolvedItem.meta.join(" \u00B7 ")}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface0,
  },
  item: {
    gap: 0,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  rowPressed: {
    opacity: 0.7,
  },
  identifier: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flexShrink: 0,
  },
  title: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flex: 1,
    minWidth: 0,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  openButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
  },
  openButtonPressed: {
    opacity: 0.7,
  },
  openButtonText: {
    fontSize: 10,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  detail: {
    paddingLeft: theme.spacing[2] + 14 + theme.spacing[2],
    paddingBottom: theme.spacing[1],
    gap: theme.spacing[1],
  },
  description: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    lineHeight: 16,
  },
  meta: {
    fontSize: 10,
    color: theme.colors.foregroundMuted,
  },
  sendButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
  },
  sendButtonPressed: {
    opacity: 0.7,
  },
  sendButtonText: {
    fontSize: 10,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
}));
