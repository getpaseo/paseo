import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SkeletonPulse, useSkeletonPulse } from "@/components/ui/skeleton";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import type { ProjectSuggestion, ProviderSuggestions } from "./suggestions";
import type {
  ProjectSuggestionsController,
  SuggestionRow as SuggestionRowModel,
} from "./use-project-suggestions";

const ThemedCheck = withUnistyles(Check);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const accentForegroundMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const SKELETON_ROWS = [0, 1, 2];

/**
 * Folders the user already ran agents in, ready to add as projects. Rows appear as each provider
 * answers and a failed provider can be retried. Adding the checked rows is the owner's primary
 * action, through the same controller. Renders nothing on a host that cannot suggest projects.
 */
export function ProjectSuggestionList({
  suggestions,
}: {
  suggestions: ProjectSuggestionsController;
}) {
  const { t } = useTranslation();
  const { list } = suggestions;
  if (list.status === "unsupported") return null;
  if (list.status === "loading") return <SuggestionsSkeleton />;

  return (
    <View style={styles.container}>
      {list.rows.length > 0 ? (
        <View style={settingsStyles.card}>
          {list.rows.map((row, index) => (
            <SuggestionRow
              key={row.suggestion.rootPath}
              row={row}
              first={index === 0}
              providerLabels={list.providerLabels}
              onToggle={list.toggle}
            />
          ))}
        </View>
      ) : (
        <Text style={styles.statusText}>
          {t("onboarding.setup.steps.projects.suggestions.empty")}
        </Text>
      )}
      {list.reading.length > 0 ? <StillReading providers={list.reading} /> : null}
      {list.failed.map((provider) => (
        <ProviderFailure key={provider.provider} provider={provider} onRetry={list.retry} />
      ))}
    </View>
  );
}

function SuggestionRow({
  row,
  first,
  providerLabels,
  onToggle,
}: {
  row: SuggestionRowModel;
  first: boolean;
  providerLabels: ReadonlyMap<string, string>;
  onToggle: (suggestion: ProjectSuggestion) => void;
}) {
  const { t } = useTranslation();
  const { suggestion, checked, addFailure } = row;
  const handlePress = useCallback(() => onToggle(suggestion), [onToggle, suggestion]);
  const accessibilityState = useMemo(() => ({ checked }), [checked]);
  const lastActivity = useTimeAgo(useMemo(() => new Date(suggestion.lastActivityAt), [suggestion]));
  const providers = suggestion.providerIds.map((id) => providerLabels.get(id) ?? id).join(" · ");
  const rowStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      settingsStyles.row,
      styles.row,
      !first && settingsStyles.rowBorder,
      hovered && styles.rowHovered,
    ],
    [first],
  );
  return (
    <PressHighlight
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole="checkbox"
      accessibilityLabel={suggestion.displayName}
      accessibilityState={accessibilityState}
      aria-checked={checked}
    >
      <View style={checked ? styles.checkboxChecked : styles.checkbox}>
        {checked ? (
          <ThemedCheck size={12} strokeWidth={3} uniProps={accentForegroundMapping} />
        ) : null}
      </View>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {suggestion.displayName}
        </Text>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {suggestion.rootPath}
        </Text>
        {addFailure === undefined ? null : (
          <Text style={settingsStyles.rowError}>
            {addFailure ?? t("onboarding.setup.steps.projects.suggestions.addFailed")}
          </Text>
        )}
      </View>
      <View style={styles.meta}>
        <Text style={styles.metaText} numberOfLines={1}>
          {providers}
        </Text>
        <Text style={styles.metaText} numberOfLines={1}>
          {t("onboarding.setup.steps.projects.suggestions.sessions", {
            count: suggestion.sessionCount,
          })}
          {" · "}
          {lastActivity}
        </Text>
      </View>
    </PressHighlight>
  );
}

function StillReading({ providers }: { providers: readonly ProviderSuggestions[] }) {
  const { t } = useTranslation();
  return (
    <View style={styles.statusRow}>
      <ThemedLoadingSpinner uniProps={mutedMapping} />
      <Text style={styles.statusText}>
        {t("onboarding.setup.steps.projects.suggestions.stillReading", {
          providers: providers.map((provider) => provider.label).join(", "),
        })}
      </Text>
    </View>
  );
}

function ProviderFailure({
  provider,
  onRetry,
}: {
  provider: ProviderSuggestions;
  onRetry: (provider: string) => void;
}) {
  const { t } = useTranslation();
  const handleRetry = useCallback(() => onRetry(provider.provider), [onRetry, provider.provider]);
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusText}>
        {t("onboarding.setup.steps.projects.suggestions.readFailed", { provider: provider.label })}
      </Text>
      <Button variant="ghost" size="sm" onPress={handleRetry}>
        {t("common.actions.retry")}
      </Button>
    </View>
  );
}

function SuggestionsSkeleton() {
  const { t } = useTranslation();
  const pulse = useSkeletonPulse();
  return (
    <View
      style={settingsStyles.card}
      accessibilityLabel={t("onboarding.setup.steps.projects.suggestions.loading")}
      testID="project-suggestions-skeleton"
    >
      {SKELETON_ROWS.map((row) => (
        <View
          key={row}
          style={[settingsStyles.row, styles.row, row > 0 && settingsStyles.rowBorder]}
        >
          <SkeletonPulse pulse={pulse} style={styles.skeletonCheckbox} />
          <View style={styles.skeletonText}>
            <SkeletonPulse pulse={pulse} style={styles.skeletonTitle} />
            <SkeletonPulse pulse={pulse} style={styles.skeletonPath} />
          </View>
        </View>
      ))}
    </View>
  );
}

const CHECKBOX_SIZE = 16;

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
  },
  row: {
    justifyContent: "flex-start",
    gap: theme.spacing[3],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  checkbox: {
    width: CHECKBOX_SIZE,
    height: CHECKBOX_SIZE,
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
  },
  checkboxChecked: {
    width: CHECKBOX_SIZE,
    height: CHECKBOX_SIZE,
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  meta: {
    alignItems: "flex-end",
    gap: theme.spacing[1],
  },
  metaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  skeletonCheckbox: {
    width: CHECKBOX_SIZE,
    height: CHECKBOX_SIZE,
    borderRadius: theme.borderRadius.sm,
  },
  skeletonText: {
    flex: 1,
    gap: theme.spacing[2],
  },
  skeletonTitle: {
    width: 140,
    height: 12,
    borderRadius: theme.borderRadius.sm,
  },
  skeletonPath: {
    width: 220,
    height: 10,
    borderRadius: theme.borderRadius.sm,
  },
}));
