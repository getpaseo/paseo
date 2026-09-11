import { useState, useCallback, useMemo } from "react";
import { Text, View, type GestureResponderEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  CHANGE_CATEGORIES,
  PRODUCTION_CATEGORIES,
  productionStat,
  sumDiffStats,
  type DiffStat as DiffStatValue,
  type LineStat,
} from "@getpaseo/protocol/diff-stat";
import { useSessionStore } from "@/stores/session-store";
import { DiffStat } from "@/components/diff-stat";
import { Button } from "@/components/ui/button";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";

interface ChangeStatsProps extends DiffStatValue {
  variant?: "summary" | "inline" | "detail" | "sidebar";
  testID?: string;
  interactive?: boolean;
  painted?: boolean;
  serverId?: string;
}

export function ChangeStats({
  variant = "summary",
  interactive = false,
  painted = false,
  serverId,
  testID,
  ...stat
}: ChangeStatsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const show = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const header = useMemo(() => ({ title: t("changeStats.title") }), [t]);
  // COMPAT(changeBreakdown): added in v0.8.0, remove gate after 2027-03-10.
  const supported = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.serverInfo?.features?.changeBreakdown === true : true,
  );
  const breakdown = supported ? stat.breakdown : undefined;
  const visibleStat = { ...stat, breakdown };
  if (variant === "detail") return <ChangeStatsDetail {...visibleStat} />;
  const estimated = Boolean(
    breakdown && (breakdown.commentsIncluded.additions || breakdown.commentsIncluded.deletions),
  );
  const code = breakdown ? productionStat(breakdown) : null;
  const hasCode = code !== null && (code.additions !== 0 || code.deletions !== 0);
  const showTotal = variant !== "sidebar" || !hasCode;
  if (stat.additions === 0 && stat.deletions === 0) return null;
  const content = (
    <View style={styles.summary} testID={testID}>
      {hasCode && (
        <View style={styles.summaryGroup} accessibilityLabel={t("changeStats.code")}>
          {estimated && variant !== "sidebar" && <Text style={styles.label}>≈</Text>}
          <DiffStat {...code} />
        </View>
      )}
      {showTotal && (
        <View style={styles.summaryGroup} accessibilityLabel={t("changeStats.total")}>
          <DiffStat additions={stat.additions} deletions={stat.deletions} muted />
        </View>
      )}
    </View>
  );
  if (!interactive) return content;
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        onPress={show}
        accessibilityLabel={t("changeStats.title")}
        style={styles.trigger}
      >
        <View style={painted && styles.painted}>{content}</View>
      </Button>
      <AdaptiveModalSheet
        testID="change-breakdown-modal"
        visible={open}
        onClose={close}
        header={header}
        desktopMaxWidth={440}
      >
        <ChangeStatsDetail {...visibleStat} />
      </AdaptiveModalSheet>
    </>
  );
}

function DetailRow({
  label,
  stat,
  indent = false,
}: {
  label: string;
  stat: LineStat;
  indent?: boolean;
}) {
  return (
    <View style={[styles.row, indent && styles.indent]}>
      <Text style={styles.label}>{label}</Text>
      <DiffStat {...stat} exact />
    </View>
  );
}

export function ChangeStatsDetail(stat: DiffStatValue) {
  const { t } = useTranslation();
  const { breakdown } = sumDiffStats([stat]);
  if (!breakdown)
    return (
      <View style={styles.detail}>
        <DetailRow label={t("changeStats.total")} stat={stat} />
        <Text style={styles.note}>{t("changeStats.unavailable")}</Text>
      </View>
    );
  const production = productionStat(breakdown);
  const excluded = CHANGE_CATEGORIES.filter(
    (category) => !PRODUCTION_CATEGORIES.some((entry) => entry === category),
  );
  const hasEstimates =
    breakdown.commentsIncluded.additions > 0 || breakdown.commentsIncluded.deletions > 0;
  return (
    <View style={styles.detail}>
      <DetailRow label={t("changeStats.total")} stat={stat} />
      <DetailRow label={t("changeStats.production")} stat={production} />
      {PRODUCTION_CATEGORIES.filter(
        (category) => breakdown[category].additions || breakdown[category].deletions,
      ).map((category) => (
        <DetailRow
          key={category}
          label={t(`changeStats.categories.${category}`)}
          stat={breakdown[category]}
          indent
        />
      ))}
      {excluded
        .filter((category) => breakdown[category].additions || breakdown[category].deletions)
        .map((category) => (
          <DetailRow
            key={category}
            label={t(`changeStats.categories.${category}`)}
            stat={breakdown[category]}
          />
        ))}
      {hasEstimates ? (
        <View style={styles.estimate}>
          <Text style={styles.note}>{t("changeStats.commentsIncluded")}</Text>
          <DiffStat {...breakdown.commentsIncluded} exact />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  painted: { opacity: 0 },
  summary: { flexDirection: "row", alignItems: "center", flexShrink: 0, gap: theme.spacing[2] },
  summaryGroup: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  label: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  note: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted, flexShrink: 1 },
  detail: { gap: theme.spacing[1], minWidth: 240 },
  indent: { paddingLeft: theme.spacing[3] },
  estimate: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[2],
    marginTop: theme.spacing[1],
    gap: theme.spacing[1],
  },
  trigger: { paddingHorizontal: 0, paddingVertical: 0, height: 20, minHeight: 20 },
}));
