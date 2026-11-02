import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { type Animated, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SkeletonPulse, useSkeletonPulse } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { projectIconRadius } from "@/components/project-icon-view";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE } from "@/styles/theme";
import { FolderProjectIcon } from "./folder-project-icon";
import type { ProjectSuggestion } from "./suggestions";
import type {
  ProjectSuggestionsController,
  SuggestionRow as SuggestionRowModel,
} from "./use-project-suggestions";

const INITIAL_SKELETON_ROWS = [0, 1, 2];
const TRAILING_SKELETON_ROWS = [0];

/**
 * Folders the user already ran agents in, ready to add as projects. Rows appear as each provider
 * answers, with skeleton rows while any is still reading; a provider that cannot read its history
 * adds nothing. Adding the checked rows is the owner's primary action, through the same
 * controller. Renders nothing on a host that cannot suggest projects.
 */
export function ProjectSuggestionList({
  serverId,
  suggestions,
}: {
  serverId: string;
  suggestions: ProjectSuggestionsController;
}) {
  const { t } = useTranslation();
  const { list } = suggestions;
  if (list.status === "unsupported") return null;
  if (list.rows.length === 0 && !list.isReading) {
    return (
      <Text style={styles.statusText}>
        {t("onboarding.setup.steps.projects.suggestions.empty")}
      </Text>
    );
  }

  return (
    <View
      style={settingsStyles.card}
      accessibilityLabel={
        list.isReading ? t("onboarding.setup.steps.projects.suggestions.loading") : undefined
      }
    >
      {list.rows.map((row, index) => (
        <SuggestionRow
          key={row.suggestion.rootPath}
          serverId={serverId}
          row={row}
          first={index === 0}
          disabled={list.isAdding}
          onToggle={list.toggle}
        />
      ))}
      {list.isReading ? <SkeletonRows afterRows={list.rows.length > 0} /> : null}
    </View>
  );
}

function SuggestionRow({
  serverId,
  row,
  first,
  disabled,
  onToggle,
}: {
  serverId: string;
  row: SuggestionRowModel;
  first: boolean;
  disabled: boolean;
  onToggle: (suggestion: ProjectSuggestion) => void;
}) {
  const { t } = useTranslation();
  const { suggestion, checked, addFailure } = row;
  const handleValueChange = useCallback(() => onToggle(suggestion), [onToggle, suggestion]);
  const lastActivity = useTimeAgo(useMemo(() => new Date(suggestion.lastActivityAt), [suggestion]));
  return (
    <View
      style={[settingsStyles.row, !first && settingsStyles.rowBorder]}
      testID="project-suggestion"
    >
      <View style={settingsStyles.rowContent}>
        <View style={styles.titleLine}>
          <FolderProjectIcon
            serverId={serverId}
            rootPath={suggestion.rootPath}
            name={suggestion.displayName}
          />
          <Text style={[settingsStyles.rowTitle, styles.title]} numberOfLines={1}>
            {suggestion.displayName}
          </Text>
        </View>
        <View style={styles.underTitle}>
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {suggestion.rootPath}
          </Text>
          <Text style={[settingsStyles.rowHint, styles.lastUsed]} numberOfLines={1}>
            {t("onboarding.setup.steps.projects.suggestions.lastUsed", { time: lastActivity })}
          </Text>
          {addFailure === undefined ? null : (
            <Text style={settingsStyles.rowError}>
              {addFailure ?? t("onboarding.setup.steps.projects.suggestions.addFailed")}
            </Text>
          )}
        </View>
      </View>
      <Switch
        value={checked}
        onValueChange={handleValueChange}
        disabled={disabled}
        accessibilityLabel={suggestion.displayName}
      />
    </View>
  );
}

/** Placeholder rows in the shape of a suggestion: icon and name, path, and the switch. */
function SkeletonRows({ afterRows }: { afterRows: boolean }) {
  const pulse = useSkeletonPulse();
  const rows = afterRows ? TRAILING_SKELETON_ROWS : INITIAL_SKELETON_ROWS;
  return rows.map((row) => <SkeletonRow key={row} pulse={pulse} bordered={afterRows || row > 0} />);
}

function SkeletonRow({ pulse, bordered }: { pulse: Animated.Value; bordered: boolean }) {
  return (
    <View
      style={[settingsStyles.row, bordered && settingsStyles.rowBorder]}
      testID="project-suggestions-skeleton"
    >
      <View style={settingsStyles.rowContent}>
        <View style={styles.titleLine}>
          <SkeletonPulse pulse={pulse} style={styles.skeletonIcon} />
          <SkeletonPulse pulse={pulse} style={styles.skeletonTitle} />
        </View>
        <View style={[styles.underTitle, styles.skeletonHints]}>
          <SkeletonPulse pulse={pulse} style={styles.skeletonPath} />
          <SkeletonPulse pulse={pulse} style={styles.skeletonLastUsed} />
        </View>
      </View>
      <SkeletonPulse pulse={pulse} style={styles.skeletonSwitch} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    flexShrink: 1,
  },
  // Path and last use line up under the name, past the icon.
  underTitle: {
    marginLeft: ICON_SIZE.md + theme.spacing[2],
  },
  lastUsed: {
    color: theme.colors.foregroundExtraMuted,
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  skeletonSwitch: {
    width: 34,
    height: 20,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  skeletonIcon: {
    width: ICON_SIZE.md,
    height: ICON_SIZE.md,
    borderRadius: projectIconRadius(ICON_SIZE.md),
    backgroundColor: theme.colors.surface2,
  },
  skeletonTitle: {
    width: 120,
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  skeletonHints: {
    marginTop: theme.spacing[2],
    gap: theme.spacing[2],
  },
  skeletonPath: {
    width: 220,
    maxWidth: "100%",
    height: 10,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  skeletonLastUsed: {
    width: 90,
    height: 10,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
}));
