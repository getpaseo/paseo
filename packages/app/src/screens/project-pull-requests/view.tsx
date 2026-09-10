import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { ExternalLink, X } from "lucide-react-native";
import { router, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { ScrollView } from "@/components/ui/scroll-view";
import { ScreenTitle } from "@/components/headers/screen-title";
import { PullRequestStateIcon } from "@/git/pull-request-state-icon";
import { useForgeSearchQuery } from "@/git/use-forge-search-query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { OverlayFrame } from "./overlay-frame";
import { ChangeStats } from "@/components/change-stats";
import { PullRequestChecks } from "./checks-view";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import type { SidebarProjectHostTarget } from "@/utils/sidebar-project-row-model";
import { WindowChromeRootRegion } from "@/utils/desktop-window";
import { useToast } from "@/contexts/toast-context";
import { openExternalUrl } from "@/utils/open-external-url";
import { ScreenHeader } from "@/components/headers/screen-header";
import { pullRequestState, serializeInitialChangeRequest } from "./model";

const RESULT_LIMIT = 50;
const REQUEST_KINDS = ["change_request" as const];

export function ProjectPullRequestsOverlay({
  target,
  displayName,
  onClose,
}: {
  target: SidebarProjectHostTarget;
  displayName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  // Keep layout on a Unistyles-owned View; SafeAreaView drops these web style classes.
  const rootStyle = useMemo(
    () => [
      styles.root,
      { paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right },
    ],
    [insets.bottom, insets.left, insets.right],
  );
  const client = useHostRuntimeClient(target.serverId);
  const connected = useHostRuntimeIsConnected(target.serverId);
  const supportsForgeSearch = useHostFeature(target.serverId, "forgeSearch");
  const supportsChecks = useHostFeature(target.serverId, "forgeSearchChecks");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [state, setState] = useState<"open" | "closed">("open");
  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timeout);
  }, [search]);
  const query = useForgeSearchQuery({
    client,
    serverId: target.serverId,
    cwd: target.iconWorkingDir,
    query: `${debouncedSearch.trim()} is:${state}`.trim(),
    kinds: REQUEST_KINDS,
    limit: RESULT_LIMIT,
    supportsForgeSearch,
    enabled: connected,
  });
  const options = useMemo(
    () => [
      { value: "open" as const, label: t("projectPullRequests.open"), testID: "project-pr-open" },
      {
        value: "closed" as const,
        label: t("projectPullRequests.closed"),
        testID: "project-pr-closed",
      },
    ],
    [t],
  );
  const select = useCallback(
    (item: ForgeSearchItem) => {
      onClose();
      router.navigate(
        buildNewWorkspaceRoute({
          serverId: target.serverId,
          sourceDirectory: target.iconWorkingDir,
          projectId: target.projectId,
          displayName,
          changeRequest: serializeInitialChangeRequest(item),
        }) as Href,
      );
    },
    [target, displayName, onClose],
  );
  const headerTitle = useMemo(
    () => (
      <ScreenTitle>
        {displayName} / {t("projectPullRequests.title")}
      </ScreenTitle>
    ),
    [displayName, t],
  );
  const closeButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={X}
        onPress={onClose}
        accessibilityLabel={t("common.actions.close")}
        testID="project-pr-close"
      />
    ),
    [onClose, t],
  );
  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const error = !connected
    ? t("workspace.terminal.hostDisconnected")
    : (query.error?.message ??
      query.data?.error ??
      (query.data && query.data.authState !== "authenticated"
        ? t("projectPullRequests.authRequired")
        : null));
  // The shared search cache keeps previous results while fetching; never display open rows under Closed.
  const items = query.isPlaceholderData || error ? [] : (query.data?.items ?? []);
  return (
    <OverlayFrame onClose={onClose}>
      <WindowChromeRootRegion corners="both">
        <View style={rootStyle}>
          <ScreenHeader left={headerTitle} right={closeButton} />
          <View style={styles.toolbar}>
            <SearchField
              value={search}
              onChangeText={setSearch}
              placeholder={t("projectPullRequests.search")}
              clearAccessibilityLabel={t("projectPullRequests.clearSearch")}
              testID="project-pr-search"
            />
          </View>
          <View style={styles.tableHeader}>
            <SegmentedControl options={options} value={state} onValueChange={setState} size="sm" />
            <Text style={styles.metadata}>
              {t("projectPullRequests.results", { count: items.length })}
            </Text>
          </View>
          {!supportsChecks ? (
            <Text style={styles.notice}>{t("projectPullRequests.checks.updateRequired")}</Text>
          ) : null}
          <ScrollView
            style={styles.list}
            keyboardShouldPersistTaps="handled"
            testID="project-pr-scroll"
          >
            <PullRequestResults
              error={error}
              loading={query.isPending || query.isPlaceholderData}
              items={items}
              onSelect={select}
              onRetry={connected ? retry : undefined}
            />
            {items.length >= RESULT_LIMIT ? (
              <Text style={styles.emptyText}>
                {t("projectPullRequests.limit", { count: RESULT_LIMIT })}
              </Text>
            ) : null}
          </ScrollView>
        </View>
      </WindowChromeRootRegion>
    </OverlayFrame>
  );
}

function PullRequestResults({
  error,
  loading,
  items,
  onSelect,
  onRetry,
}: {
  error: string | null | undefined;
  loading: boolean;
  items: ForgeSearchItem[];
  onSelect: (item: ForgeSearchItem) => void;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  if (error)
    return (
      <View style={styles.empty}>
        <Text style={styles.metadata}>{error}</Text>
        {onRetry ? (
          <Button variant="outline" size="sm" onPress={onRetry}>
            {t("common.actions.retry")}
          </Button>
        ) : null}
      </View>
    );
  if (loading) return <Text style={styles.emptyText}>{t("projectPullRequests.loading")}</Text>;
  if (items.length === 0)
    return <Text style={styles.emptyText}>{t("projectPullRequests.empty")}</Text>;
  return items.map((item) => (
    <PullRequestRow
      key={`${item.forge}:${item.projectPath}:${item.number}`}
      item={item}
      onSelect={onSelect}
    />
  ));
}

function PullRequestRow({
  item,
  onSelect,
}: {
  item: ForgeSearchItem;
  onSelect: (item: ForgeSearchItem) => void;
}) {
  const { t } = useTranslation();
  const select = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onSelect(item);
    },
    [item, onSelect],
  );
  const toast = useToast();
  const openExternal = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      void openExternalUrl(item.url).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : t("common.errors.error"));
      });
    },
    [item.url, toast, t],
  );
  const state = pullRequestState(item.state);
  const rowStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (hovered || pressed) && styles.rowHighlighted,
    ],
    [],
  );
  return (
    <Pressable
      style={rowStyle}
      onPress={select}
      accessibilityRole="button"
      accessibilityLabel={t("projectPullRequests.start", {
        number: item.number,
        title: item.title,
      })}
      testID={`project-pr-${item.number}`}
    >
      <View style={styles.stateIcon}>
        <PullRequestStateIcon state={state} size={18} />
      </View>
      <View style={styles.rowMain}>
        <View style={styles.titleLine}>
          <Text style={styles.title}>{item.title}</Text>
          <PullRequestChecks item={item} />
          {item.diffStat && (
            <ChangeStats {...item.diffStat} testID={`project-pr-diff-${item.number}`} />
          )}
          {item.labels.map((label) => (
            <StatusBadge key={label} label={label} />
          ))}
        </View>
        <Text style={styles.metadata}>
          #{item.number} · {item.headRefName}
          {item.baseRefName ? ` → ${item.baseRefName}` : ""}
          {item.updatedAt
            ? ` · ${t("projectPullRequests.updated", { date: new Date(item.updatedAt).toLocaleDateString() })}`
            : ""}
        </Text>
      </View>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={ExternalLink}
        onPress={openExternal}
        accessibilityLabel={t("projectPullRequests.external", { number: item.number })}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0, overflow: "hidden", backgroundColor: theme.colors.surface0 },
  toolbar: { flexDirection: "row", padding: theme.spacing[4] },
  tableHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  list: { flex: 1, minHeight: 0 },
  notice: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rowHighlighted: { backgroundColor: theme.colors.interactionHighlight },
  stateIcon: { paddingTop: theme.spacing[1] },
  rowMain: { flex: 1, minWidth: 0, gap: theme.spacing[2] },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  metadata: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  empty: { padding: theme.spacing[6], alignItems: "center", gap: theme.spacing[3] },
  emptyText: {
    padding: theme.spacing[6],
    textAlign: "center",
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
}));
