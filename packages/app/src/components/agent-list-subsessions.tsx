import { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { AgentSubsessionPayload } from "@getpaseo/protocol/messages";
import { AgentStatusDot } from "@/components/agent-status-dot";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

const DISCLOSURE_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };

export const SubsessionDisclosure = memo(function SubsessionDisclosure({
  count,
  expanded,
  onToggle,
  testID,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
  testID: string;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  if (count <= 0) {
    return null;
  }
  return (
    <Pressable
      onPress={onToggle}
      hitSlop={DISCLOSURE_HIT_SLOP}
      style={styles.disclosureButton}
      accessibilityRole="button"
      accessibilityLabel={t("subagents.toggle")}
      accessibilityState={accessibilityState}
      testID={testID}
    >
      {expanded ? (
        <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      ) : (
        <ChevronRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      )}
    </Pressable>
  );
});

export const SubsessionRow = memo(function SubsessionRow({
  sub,
  depth,
  agent,
  onPressSubsession,
}: {
  sub: AgentSubsessionPayload;
  depth: number;
  agent: AggregatedAgent;
  onPressSubsession: (agent: AggregatedAgent, sub: AgentSubsessionPayload) => void;
}) {
  const { t } = useTranslation();

  const indentStyle = useMemo(() => ({ paddingLeft: depth * INDENT_PER_LEVEL }), [depth]);
  const innerStyle = useMemo(() => [styles.rowInner, indentStyle], [indentStyle]);

  const rowStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [styles.row, pressed && styles.rowPressed],
    [],
  );

  const handlePress = useCallback(
    () => onPressSubsession(agent, sub),
    [onPressSubsession, agent, sub],
  );

  const title = sub.title ?? t("subagents.fallbackTitle");

  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      accessibilityLabel={title}
      testID={`agent-subsession-row-${agent.serverId}-${agent.id}-${sub.id}`}
    >
      <View style={innerStyle}>
        <View style={styles.statusDotSlot}>
          <AgentStatusDot status={sub.status} requiresAttention={false} />
        </View>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
      </View>
    </Pressable>
  );
});

const INDENT_PER_LEVEL = 16;

const styles = StyleSheet.create((theme) => ({
  disclosureButton: {
    width: theme.iconSize.sm,
    height: theme.iconSize.sm,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  row: {
    minHeight: 28,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    userSelect: "none",
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  rowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  statusDotSlot: {
    width: 8,
    height: 8,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    opacity: 0.76,
    flex: 1,
    minWidth: 0,
  },
}));
