import { useTranslation } from "react-i18next";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { WorkspaceTabMenuEntry } from "@/screens/workspace/workspace-tab-menu";
import { useMemo } from "react";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useAgentCreation } from "../runtime";
import type { CreationAttempt } from "../model";

export function CreatingWorkspaceRow({
  attempt,
  selected,
  onPress,
}: {
  attempt: CreationAttempt;
  selected: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={t("newWorkspace.creation.creatingLabel")}
      accessibilityState={accessibilityState}
      testID={`sidebar-workspace-row-${attempt.serverId}:${attempt.workspaceId}`}
      onPress={onPress}
      style={styles.pendingRow}
    >
      <Text style={styles.status}>{t("newWorkspace.creation.creatingWorkspace")}</Text>
    </PressHighlight>
  );
}
const styles = StyleSheet.create((theme) => ({
  pendingRow: { paddingHorizontal: theme.spacing[4], paddingVertical: theme.spacing[2] },
  status: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));

const RESOURCE_ACTIONS = new Set(["rename", "reload-agent", "copy-resume-command"]);
export function useCreationTabMenuEntries(
  serverId: string,
  target: WorkspaceTabTarget,
  entries: WorkspaceTabMenuEntry[],
): WorkspaceTabMenuEntry[] {
  const agentId = target.kind === "agent" ? target.agentId : "";
  const creation = useAgentCreation(serverId, agentId);
  return useMemo(() => {
    if (!creation) return entries;
    return entries.map((entry) =>
      entry.kind === "item" && RESOURCE_ACTIONS.has(entry.key)
        ? { ...entry, disabled: true }
        : entry,
    );
  }, [creation, entries]);
}
