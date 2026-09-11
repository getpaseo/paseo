import { BackgroundActivityPanel } from "./activity-panel";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Activity } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import type { BackgroundAttempt } from "@getpaseo/protocol/messages";
import { AgentStreamView, type AgentStreamViewHandle } from "@/agent-stream/view";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { Button } from "@/components/ui/button";
import { ExpandableBadge } from "@/components/message";
import type { PendingPermission } from "@/types/shared";
import { useBackgroundActivity } from "./use-background-activity";
import { projectBackgroundRows } from "./presentation";

const ThemedActivity = withUnistyles(Activity);
const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();

function AttemptLink({
  attempt,
  requestId,
  current,
  onOpen,
}: {
  attempt: BackgroundAttempt;
  requestId: string;
  current: string;
  onOpen: (conversationId: string, requestId: string) => void;
}) {
  const { t } = useTranslation();
  const open = useCallback(
    () => onOpen(attempt.conversationId, requestId),
    [onOpen, attempt.conversationId, requestId],
  );
  return (
    <View style={styles.toolbar}>
      <Button variant="ghost" disabled={attempt.conversationId === current} onPress={open}>
        {attempt.provider} /{" "}
        {attempt.resolvedModel ??
          attempt.configuredModel ??
          t("backgroundActivity.providerDefault")}
      </Button>
      {attempt.error ? (
        <Text selectable style={styles.error}>
          {attempt.error}
        </Text>
      ) : null}
    </View>
  );
}

function BackgroundThreadPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target, openFileInWorkspace, openTab } = usePaneContext();
  invariant(target.kind === "background_thread", "Expected a background thread target");
  const { snapshot, error, supported, connected, retry } = useBackgroundActivity(
    serverId,
    target.conversationId,
  );
  const view = useRef<AgentStreamViewHandle>(null);
  const [showInstructions, setShowInstructions] = useState(false);
  const toggleInstructions = useCallback(() => setShowInstructions((value) => !value), []);
  const renderInstructions = useCallback(
    () => (
      <Text selectable style={styles.instructions}>
        {snapshot?.conversation?.systemPrompt ?? t("backgroundActivity.noInstructions")}
      </Text>
    ),
    [snapshot?.conversation?.systemPrompt, t],
  );
  const projected = useMemo(
    () => projectBackgroundRows(snapshot?.rows ?? [], snapshot?.epoch ?? ""),
    [snapshot?.rows, snapshot?.epoch],
  );
  const active =
    snapshot?.requests.some((request) =>
      request.attempts.some(
        (attempt) => attempt.conversationId === target.conversationId && !attempt.finishedAt,
      ),
    ) ?? false;
  const context = useMemo<AgentScreenAgent>(
    () => ({
      id: target.conversationId,
      serverId,
      workspaceId,
      provider: snapshot?.conversation?.provider,
      cwd: snapshot?.conversation?.cwd ?? "",
      status: active ? "running" : "idle",
    }),
    [target.conversationId, serverId, workspaceId, snapshot?.conversation, active],
  );
  const turn = useMemo(
    () => ({ isActive: active, isCancelling: false, startedAt: null, turnId: null }),
    [active],
  );
  const selectedPrompt = target.requestId ? projected.prompts.get(target.requestId) : undefined;
  useEffect(() => {
    if (!selectedPrompt || snapshot?.hasMore) return;
    const frame = requestAnimationFrame(() => view.current?.scrollToMessage(selectedPrompt));
    return () => cancelAnimationFrame(frame);
  }, [selectedPrompt, target.requestId, snapshot?.hasMore]);
  const header = useCallback(
    (messageId: string) => {
      const request = snapshot?.requests.find((entry) =>
        entry.attempts.some((attempt) => attempt.id === messageId),
      );
      const attempt = request?.attempts.find((entry) => entry.id === messageId);
      if (!attempt || !request) return null;
      let status = attempt.finishedAt ? "completed" : "running";
      if (attempt.error) status = "failed";
      return (
        <View style={styles.attempt}>
          <Text style={styles.title}>
            {t(`backgroundActivity.kind.${request.kind}`)} · {attempt.provider} /{" "}
            {attempt.resolvedModel ??
              attempt.configuredModel ??
              t("backgroundActivity.providerDefault")}
          </Text>
          <Text style={styles.muted}>
            {new Date(attempt.startedAt).toLocaleTimeString()} ·{" "}
            {t(`backgroundActivity.status.${status}`)}
            {attempt.finishedAt
              ? ` · ${((attempt.finishedAt - attempt.startedAt) / 1000).toFixed(1)}s`
              : ""}
          </Text>
          {attempt.error ? (
            <Text selectable style={styles.error}>
              {attempt.error}
            </Text>
          ) : null}
        </View>
      );
    },
    [snapshot?.requests, t],
  );
  const openAttempt = useCallback(
    (conversationId: string, requestId: string) => {
      openTab({ kind: "background_thread", conversationId, requestId });
    },
    [openTab],
  );
  if (!supported) return <Text style={styles.message}>{t("backgroundActivity.unsupported")}</Text>;
  if (error)
    return (
      <View>
        <Text style={styles.error}>{error}</Text>
        <Button variant="ghost" onPress={retry}>
          {t("backgroundActivity.retry")}
        </Button>
      </View>
    );
  if (!snapshot) return <Text style={styles.message}>{t("backgroundActivity.loading")}</Text>;
  if (!snapshot.conversation)
    return <Text style={styles.message}>{t("backgroundActivity.unavailable")}</Text>;
  return (
    <View style={styles.container}>
      {!connected ? (
        <Text style={styles.message}>{t("backgroundActivity.disconnected")}</Text>
      ) : null}
      {snapshot.conversation.truncated ? (
        <Text style={styles.message}>{t("backgroundActivity.truncated")}</Text>
      ) : null}
      <View style={styles.toolbar}>
        <ExpandableBadge
          label={t("backgroundActivity.instructions")}
          isExpanded={showInstructions}
          onToggle={toggleInstructions}
          renderDetails={renderInstructions}
        />
      </View>
      {snapshot.requests
        .filter((request) => request.id === (target.requestId ?? snapshot.requests.at(-1)?.id))
        .filter(
          (request) =>
            request.attempts.length > 1 || request.attempts.some((attempt) => attempt.error),
        )
        .flatMap((request) =>
          request.attempts.map((attempt) => (
            <AttemptLink
              key={attempt.id}
              attempt={attempt}
              requestId={request.id}
              current={target.conversationId}
              onOpen={openAttempt}
            />
          )),
        )}
      <AgentStreamView
        ref={view}
        agentId={target.conversationId}
        serverId={serverId}
        context={context}
        streamItems={projected.items}
        pendingPermissions={EMPTY_PERMISSIONS}
        turnPresentation={turn}
        readOnly
        isAuthoritativeHistoryReady={!snapshot.hasMore}
        renderUserMessageHeader={header}
        onOpenWorkspaceFile={openFileInWorkspace}
      />
    </View>
  );
}

const activityPresentation = {
  label: (t) => t("backgroundActivity.title"),
  subtitle: (t) => t("backgroundActivity.subtitle"),
  tooltip: (t) => t("backgroundActivity.title"),
  icon: ThemedActivity,
} satisfies PanelPresentation;
const threadPresentation = {
  ...activityPresentation,
  label: (t) => t("backgroundActivity.thread"),
} satisfies PanelPresentation;
export const backgroundActivityPanelRegistration = definePanel("background_activity", {
  component: BackgroundActivityPanel,
  presentation: activityPresentation,
});
export const backgroundThreadPanelRegistration = definePanel("background_thread", {
  component: BackgroundThreadPanel,
  presentation: threadPresentation,
});

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  toolbar: { paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[2] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[2],
  },
  message: { color: theme.colors.foregroundMuted, padding: theme.spacing[4] },
  instructions: {
    color: theme.colors.foreground,
    padding: theme.spacing[3],
    fontSize: theme.fontSize.sm,
  },
  attempt: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    gap: theme.spacing[1],
  },
}));
