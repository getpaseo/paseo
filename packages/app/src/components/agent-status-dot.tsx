import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  AGENT_LIFECYCLE_STATUSES,
  type AgentLifecycleStatus,
} from "@getpaseo/protocol/agent-lifecycle";
import { deriveAgentBucketWithSubagentActivity } from "@/subagents/agent-activity";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";

export function AgentStatusDot({
  status,
  requiresAttention,
  attentionReason,
  pendingPermissionCount,
  hasRunningProviderSubagent = false,
  showInactive = false,
}: {
  status: string | null | undefined;
  requiresAttention: boolean | null | undefined;
  attentionReason?: "finished" | "error" | "permission" | null;
  pendingPermissionCount?: number;
  hasRunningProviderSubagent?: boolean;
  showInactive?: boolean;
}) {
  const { theme } = useUnistyles();

  if (!status) {
    return null;
  }
  if (!isAgentLifecycleStatus(status)) {
    return null;
  }

  const bucket = deriveAgentBucketWithSubagentActivity({
    agent: {
      status,
      requiresAttention: Boolean(requiresAttention),
      attentionReason: attentionReason ?? null,
      pendingPermissionCount: pendingPermissionCount ?? 0,
    },
    hasRunningProviderSubagent,
  });
  const color = getStatusDotColor({ theme, bucket, showDoneAsInactive: showInactive });

  if (!color) {
    return null;
  }

  return <AgentStatusDotView color={color} />;
}

function AgentStatusDotView({ color }: { color: string }) {
  const dotStyle = useMemo(() => [styles.dot, { backgroundColor: color }], [color]);
  return <View style={dotStyle} />;
}

function isAgentLifecycleStatus(value: string): value is AgentLifecycleStatus {
  return AGENT_LIFECYCLE_STATUSES.some((status) => status === value);
}

const styles = StyleSheet.create((theme) => ({
  dot: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
  },
}));
