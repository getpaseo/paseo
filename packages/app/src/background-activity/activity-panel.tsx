import React, { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { BackgroundRequest } from "@getpaseo/protocol/messages";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { usePaneContext } from "@/panels/pane-context";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { Button } from "@/components/ui/button";
import { useBackgroundActivity } from "./use-background-activity";
import { sortBackgroundRequests } from "./presentation";

function RequestRow({
  request,
  now,
  onOpen,
}: {
  request: BackgroundRequest;
  now: number;
  onOpen: (request: BackgroundRequest) => void;
}) {
  const { t } = useTranslation();
  const open = useCallback(() => onOpen(request), [onOpen, request]);
  const attempt = request.attempts.at(-1);
  const duration = Math.max(0, ((request.finishedAt ?? now) - request.createdAt) / 1000).toFixed(1);
  return (
    <Pressable
      onPress={open}
      disabled={!attempt}
      accessibilityRole="button"
      style={styles.request}
      testID="background-request"
    >
      <Text style={styles.title}>
        {request.purpose === "chapters"
          ? t("chapters.title")
          : t(`backgroundActivity.kind.${request.kind}`)}
        {request.kind === "labels" ? ` · ${request.count}` : ""}
      </Text>
      <Text style={styles.muted} numberOfLines={1}>
        {request.sourceTitle ?? request.cwd}
      </Text>
      {request.sourceTitle ? (
        <Text style={styles.muted} numberOfLines={1}>
          {request.cwd}
        </Text>
      ) : null}
      <Text style={styles.muted}>
        {attempt
          ? `${attempt.provider} / ${attempt.resolvedModel ?? attempt.configuredModel ?? t("backgroundActivity.providerDefault")}`
          : t("backgroundActivity.awaitingModel")}
      </Text>
      <Text style={styles.muted}>
        {t(`backgroundActivity.status.${request.status}`)} · {duration}s
      </Text>
      {request.error ? (
        <Text style={styles.error} numberOfLines={2}>
          {request.error}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function BackgroundActivityPanel() {
  const { serverId, workspaceId, openTab } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  return (
    <BackgroundActivityContent
      serverId={serverId}
      workspaceId={workspaceId}
      cwd={cwd ?? ""}
      openTab={openTab}
    />
  );
}

export function BackgroundActivityContent({
  serverId,
  workspaceId,
  cwd,
  openTab,
}: {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
  openTab: (target: WorkspaceTabTarget) => void;
}) {
  const { t } = useTranslation();
  const { snapshot, error, supported, connected, retry } = useBackgroundActivity(serverId);
  const [allWorkspaces, setAllWorkspaces] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const toggleScope = useCallback(() => setAllWorkspaces((value) => !value), []);
  const open = useCallback(
    (request: BackgroundRequest) => {
      const attempt = request.attempts.at(-1);
      if (attempt)
        openTab({
          kind: "background_thread",
          conversationId: attempt.conversationId,
          requestId: request.id,
        });
    },
    [openTab],
  );
  const requests = sortBackgroundRequests(snapshot?.requests ?? []).filter(
    (request) =>
      allWorkspaces ||
      request.workspaceId === workspaceId ||
      (!request.workspaceId && request.cwd === cwd),
  );
  if (!supported) return <Text style={styles.message}>{t("backgroundActivity.unsupported")}</Text>;
  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Button variant="ghost" onPress={toggleScope}>
          {t(
            allWorkspaces ? "backgroundActivity.allWorkspaces" : "backgroundActivity.thisWorkspace",
          )}
        </Button>
      </View>
      {!connected ? (
        <Text style={styles.message}>{t("backgroundActivity.disconnected")}</Text>
      ) : null}
      {error ? (
        <View>
          <Text style={styles.error}>{error}</Text>
          <Button variant="ghost" onPress={retry}>
            {t("backgroundActivity.retry")}
          </Button>
        </View>
      ) : null}
      <ScrollView>
        {requests.map((request) => (
          <RequestRow key={request.id} request={request} now={now} onOpen={open} />
        ))}
        {!requests.length ? (
          <Text style={styles.message}>
            {t(snapshot ? "backgroundActivity.empty" : "backgroundActivity.loading")}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  toolbar: { paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[2] },
  request: {
    padding: theme.spacing[3],
    gap: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
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
}));
