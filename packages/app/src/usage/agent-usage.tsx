import { type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { FloatingScrollView } from "@/components/ui/floating";
import { UsageCard } from "./card";
import { usageCopy } from "./copy";
import { useUsageDisplay } from "./display";
import { useAgentUsage } from "./queries";
import type { UsageReportEntry } from "./types";

/**
 * The usage of the account an agent runs under, for its context window details: one card per
 * report as it streams in, without pins. Nothing on hosts that cannot report usage, or for an
 * agent with no account to report.
 */
export function AgentUsage({
  serverId,
  agentId,
  refreshable,
  scrollable = false,
}: {
  serverId: string;
  agentId: string;
  /** Whether each card has a Refresh button. */
  refreshable: boolean;
  /** Limit long report lists in a floating surface. */
  scrollable?: boolean;
}) {
  const view = useAgentUsage(serverId, agentId);
  if (view.kind === "none") return null;

  let content: ReactNode;
  if (view.kind === "ready") {
    const cards = (
      <AgentUsageCards
        serverId={serverId}
        agentId={agentId}
        reports={view.reports}
        refreshable={refreshable}
      />
    );
    content = scrollable ? (
      <FloatingScrollView
        bounces={false}
        contentContainerStyle={styles.reports}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        style={styles.reportScroll}
      >
        {cards}
      </FloatingScrollView>
    ) : (
      cards
    );
  } else {
    content = (
      <Text style={styles.message}>
        {view.kind === "loading" ? usageCopy.loading : view.message}
      </Text>
    );
  }

  return (
    <>
      <View style={styles.divider} />
      {content}
    </>
  );
}

function AgentUsageCards({
  serverId,
  agentId,
  reports,
  refreshable,
}: {
  serverId: string;
  agentId: string;
  reports: readonly UsageReportEntry[];
  refreshable: boolean;
}) {
  const { display } = useUsageDisplay(reports);
  return reports.map((entry) => (
    <UsageCard
      key={entry.id}
      serverId={serverId}
      agentId={agentId}
      entry={entry}
      display={display}
      compact
      pinnable={false}
      refreshable={refreshable}
    />
  ));
}

const styles = StyleSheet.create((theme) => ({
  divider: { height: 1, backgroundColor: theme.colors.borderAccent },
  message: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  reports: { alignSelf: "stretch", gap: theme.spacing[3] },
  reportScroll: { alignSelf: "stretch", maxHeight: 240 },
}));
