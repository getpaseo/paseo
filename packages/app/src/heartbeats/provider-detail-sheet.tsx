import { useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import type { HeartbeatRow } from "./select";

export interface ProviderHeartbeatDetailSheetProps {
  visible: boolean;
  row: Extract<HeartbeatRow, { kind: "provider" }> | null;
  onClose: () => void;
}

function modeLabel(
  mode: Extract<HeartbeatRow, { kind: "provider" }>["mode"],
  t: (key: string) => string,
): string {
  switch (mode) {
    case "recurring":
      return t("heartbeats.modeRecurring");
    case "one_shot":
      return t("heartbeats.modeOneShot");
    case "dynamic":
      return t("heartbeats.modeDynamic");
    default:
      return mode;
  }
}

export function ProviderHeartbeatDetailSheet({
  visible,
  row,
  onClose,
}: ProviderHeartbeatDetailSheetProps): ReactElement | null {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(() => ({ title: t("heartbeats.providerDetailTitle") }), [t]);

  if (!row) {
    return null;
  }

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      testID="provider-heartbeat-detail-sheet"
      snapPoints={["50%", "75%"]}
    >
      <View style={styles.body}>
        <DetailField label={t("heartbeats.detailPrompt")} value={row.prompt || "—"} />
        <DetailField label={t("heartbeats.detailMode")} value={modeLabel(row.mode, t)} />
        <DetailField label={t("heartbeats.detailSchedule")} value={row.scheduleLabel || "—"} />
        <DetailField
          label={t("heartbeats.detailNext")}
          value={row.nextHint?.trim() ? row.nextHint : t("heartbeats.noNextHint")}
        />
        <DetailField label={t("heartbeats.detailTaskId")} value={row.id} mono />
      </View>
    </AdaptiveModalSheet>
  );
}

function DetailField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): ReactElement {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Text style={mono ? styles.valueMono : styles.value} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  field: {
    gap: theme.spacing[1],
  },
  label: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  value: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  valueMono: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
  },
}));
