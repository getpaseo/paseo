import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check } from "@/components/icons/ui-icons";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { RelatedPullRequest } from "@/git/related-pull-requests";
import type { Theme } from "@/styles/theme";

const ThemedCheck = withUnistyles(Check);
const checkMapping = (theme: Theme) => ({ color: theme.colors.background });

export interface ScanChatFinding {
  pullRequest: RelatedPullRequest;
  /** How often the chat named it, which is what orders the list. */
  mentions: number;
}

/**
 * What a chat scan turned up, for someone to confirm.
 *
 * The scan cannot tell which of the pull requests a conversation named are the
 * ones this workspace is about. A session that ships eight can easily mention a
 * dozen, and the gap between the eighth and the ninth is not a number a rule can
 * pick. So the scan proposes and the person decides, with the mention count
 * visible because that is the evidence the ranking rests on.
 */
export function ScanChatDialog({
  findings,
  unresolved,
  onAttach,
  onClose,
}: {
  findings: readonly ScanChatFinding[];
  unresolved: readonly number[];
  onAttach: (pullRequests: RelatedPullRequest[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(() => new Set());

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("workspace.git.pr.set.scanChatTitle"),
      subtitle: t("workspace.git.pr.set.scanChatSubtitle", { count: findings.length }),
    }),
    [findings.length, t],
  );

  const toggle = useCallback((number: number) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(number)) {
        next.delete(number);
      } else {
        next.add(number);
      }
      return next;
    });
  }, []);

  const selected = useMemo(
    () => findings.filter((finding) => !excluded.has(finding.pullRequest.number)),
    [excluded, findings],
  );

  const handleAttach = useCallback(() => {
    onAttach(selected.map((finding) => finding.pullRequest));
    onClose();
  }, [onAttach, onClose, selected]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      desktopMaxWidth={560}
      testID="scan-chat-dialog"
    >
      <View style={styles.list}>
        {findings.map((finding) => (
          <FindingRow
            key={finding.pullRequest.number}
            finding={finding}
            selected={!excluded.has(finding.pullRequest.number)}
            onToggle={toggle}
          />
        ))}
        {unresolved.length > 0 ? (
          <Text style={styles.note}>
            {t("workspace.git.pr.set.scanChatUnresolved", { numbers: unresolved.join(", ") })}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button variant="ghost" onPress={onClose} testID="scan-chat-cancel">
            {t("common.actions.cancel")}
          </Button>
          <Button onPress={handleAttach} disabled={selected.length === 0} testID="scan-chat-attach">
            {t("workspace.git.pr.set.scanChatAttach", { count: selected.length })}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function FindingRow({
  finding,
  selected,
  onToggle,
}: {
  finding: ScanChatFinding;
  selected: boolean;
  onToggle: (number: number) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(
    () => onToggle(finding.pullRequest.number),
    [finding.pullRequest.number, onToggle],
  );
  const accessibilityState = useMemo(() => ({ checked: selected }), [selected]);
  return (
    <Pressable
      style={styles.row}
      onPress={handlePress}
      accessibilityRole="checkbox"
      accessibilityState={accessibilityState}
      testID={`scan-chat-finding-${finding.pullRequest.number}`}
    >
      <View style={selected ? styles.boxChecked : styles.box}>
        {selected ? <ThemedCheck size={12} uniProps={checkMapping} /> : null}
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          #{finding.pullRequest.number} {finding.pullRequest.title}
        </Text>
        <Text style={styles.rowDetail}>
          {t("workspace.git.pr.set.scanChatMentions", { count: finding.mentions })}
          {" · "}
          {finding.pullRequest.state}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  box: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  boxChecked: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rowDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[0.5],
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    paddingTop: theme.spacing[3],
  },
}));
