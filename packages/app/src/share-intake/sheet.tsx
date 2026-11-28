import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { resolveAgentLabel } from "@/agent-presentation";
import {
  AdaptiveModalSheet,
  FULL_SHEET_SNAP_POINTS,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useToast } from "@/contexts/toast-api-context";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useProjects } from "@/hooks/use-projects";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useHosts } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { deliverShare } from "./deliver";
import { deliverShareRuntime } from "./deliver-runtime";
import { describeIncomingShare, type IncomingShare } from "./model";
import { finishShare } from "./store";
import {
  buildShareTargetRows,
  rankShareTargetRows,
  type ShareTargetRow,
  type ShareTargetRows,
} from "./targets";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Asks where a share from another app goes: an agent's composer or a new agent in a workspace. */
export function ShareTargetSheet({ share }: { share: IncomingShare | null }) {
  const { t } = useTranslation();
  // The sheet animates out after the share is finished; keep drawing what it showed.
  const [shown, setShown] = useState(share);
  if (share && share !== shown) setShown(share);
  const content = share ?? shown;
  // Each share starts with an empty search; the header's resetKey clears the field to match.
  const [search, setSearch] = useState({ shareId: "", query: "" });
  const query = content && search.shareId === content.id ? search.query : "";
  const contentId = content?.id ?? "";
  const handleQueryChange = useCallback(
    (value: string) => setSearch({ shareId: contentId, query: value }),
    [contentId],
  );
  const close = useCallback(() => {
    if (share) finishShare(share.id);
  }, [share]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("shareIntake.title"),
      subtitle: content ? (
        <Text style={styles.subtitle} numberOfLines={1} testID="share-target-summary">
          {describeIncomingShare(content)}
        </Text>
      ) : null,
      search: {
        onChange: handleQueryChange,
        placeholder: t("shareIntake.searchPlaceholder"),
        resetKey: contentId,
        testID: "share-target-search",
      },
    }),
    [content, contentId, handleQueryChange, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={share !== null}
      onClose={close}
      snapPoints={FULL_SHEET_SNAP_POINTS}
      testID="share-target-sheet"
    >
      {content ? (
        <ShareTargetList key={content.id} share={content} query={query} open={share !== null} />
      ) : null}
    </AdaptiveModalSheet>
  );
}

function useShareTargetRows(open: boolean): { rows: ShareTargetRows; isLoading: boolean } {
  const { t } = useTranslation();
  const { agents, isInitialLoad } = useAggregatedAgents({ demand: open });
  const { projects, isLoading: projectsLoading } = useProjects({ enabled: open });
  const showHost = useHosts().length > 1;
  const agentTitle = useCallback(
    (agent: AggregatedAgent) => resolveAgentLabel(agent.title) ?? t("workspace.tabs.loading"),
    [t],
  );
  const rows = useMemo(
    () => buildShareTargetRows({ agents, projects, showHost, agentTitle }),
    [agentTitle, agents, projects, showHost],
  );
  return { rows, isLoading: isInitialLoad || projectsLoading };
}

function ShareTargetList({
  share,
  query,
  open,
}: {
  share: IncomingShare;
  query: string;
  open: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { rows, isLoading } = useShareTargetRows(open);
  const ranked = useMemo(() => rankShareTargetRows(rows, query), [query, rows]);
  const [deliveringRowId, setDeliveringRowId] = useState<string | null>(null);

  const deliver = useStableEvent(async (row: ShareTargetRow) => {
    if (deliveringRowId) return;
    setDeliveringRowId(row.id);
    try {
      await deliverShare(share, row.target, deliverShareRuntime);
      finishShare(share.id);
    } catch (error) {
      console.error("[ShareIntake] Failed to add the share to a draft", error);
      toast.error(
        error instanceof Error && error.message ? error.message : t("shareIntake.deliverFailed"),
      );
    } finally {
      setDeliveringRowId(null);
    }
  });

  const hasAnyTarget = rows.agents.length > 0 || rows.workspaces.length > 0;
  if (!hasAnyTarget) {
    return (
      <View style={styles.emptyState} testID="share-target-empty">
        {isLoading ? (
          <ThemedLoadingSpinner uniProps={mutedColorMapping} />
        ) : (
          <Text style={styles.emptyStateText}>{t("shareIntake.empty")}</Text>
        )}
      </View>
    );
  }
  if (ranked.agents.length === 0 && ranked.workspaces.length === 0) {
    return (
      <View style={styles.emptyState} testID="share-target-no-matches">
        <Text style={styles.emptyStateText}>{t("common.empty.noResults")}</Text>
      </View>
    );
  }

  return (
    <>
      {ranked.agents.length > 0 ? (
        <SettingsSection title={t("shareIntake.agents")} testID="share-target-agents">
          <View style={settingsStyles.card}>
            {ranked.agents.map((row, index) => (
              <ShareTargetRowView
                key={row.id}
                row={row}
                withBorder={index > 0}
                delivering={deliveringRowId === row.id}
                disabled={deliveringRowId !== null}
                onSelect={deliver}
              />
            ))}
          </View>
        </SettingsSection>
      ) : null}
      {ranked.workspaces.length > 0 ? (
        <SettingsSection title={t("shareIntake.newAgent")} testID="share-target-workspaces" flush>
          <View style={settingsStyles.card}>
            {ranked.workspaces.map((row, index) => (
              <ShareTargetRowView
                key={row.id}
                row={row}
                withBorder={index > 0}
                delivering={deliveringRowId === row.id}
                disabled={deliveringRowId !== null}
                onSelect={deliver}
              />
            ))}
          </View>
        </SettingsSection>
      ) : null}
    </>
  );
}

function ShareTargetRowView({
  row,
  withBorder,
  delivering,
  disabled,
  onSelect,
}: {
  row: ShareTargetRow;
  withBorder: boolean;
  delivering: boolean;
  disabled: boolean;
  onSelect: (row: ShareTargetRow) => void;
}) {
  const handlePress = useCallback(() => onSelect(row), [onSelect, row]);
  const rowStyle = useMemo(
    () => [settingsStyles.row, withBorder ? settingsStyles.rowBorder : null],
    [withBorder],
  );
  const accessibilityState = useMemo(
    () => ({ disabled, busy: delivering }),
    [delivering, disabled],
  );
  return (
    <PressHighlight
      style={rowStyle}
      onPress={handlePress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={row.title}
      accessibilityHint={row.subtitle || undefined}
      accessibilityState={accessibilityState}
      testID={`share-target-${row.id}`}
    >
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {row.title}
        </Text>
        {row.subtitle ? (
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {row.subtitle}
          </Text>
        ) : null}
      </View>
      {delivering ? <ThemedLoadingSpinner uniProps={mutedColorMapping} /> : null}
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  subtitle: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[8],
    paddingHorizontal: theme.spacing[4],
  },
  emptyStateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
