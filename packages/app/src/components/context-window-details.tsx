import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AgentUsage } from "@/usage";
import { formatTokenCount } from "./context-window-meter.utils";

interface ContextWindowDetailsProps {
  serverId: string;
  agentId: string;
  percentage: number;
  usedTokens: number;
  maxTokens: number;
  sessionCost: string | null;
  /** The tooltip titles itself; the sheet's header carries the title instead. */
  showTitle: boolean;
  /** Only the sheet can be pressed, so only its usage cards have a Refresh button. */
  refreshable: boolean;
}

/**
 * What the context window meter opens: how full the window is, then the usage of the agent's
 * account. The wide tooltip and the compact sheet both render it.
 */
export function ContextWindowDetails({
  serverId,
  agentId,
  percentage,
  usedTokens,
  maxTokens,
  sessionCost,
  showTitle,
  refreshable,
}: ContextWindowDetailsProps) {
  const { t } = useTranslation();
  return (
    <>
      <View style={styles.summary}>
        {showTitle ? <Text style={styles.title}>{t("contextWindow.title")}</Text> : null}
        <Text style={styles.text}>{t("contextWindow.used", { percentage })}</Text>
        <Text style={styles.detail}>
          {t("contextWindow.tokens", {
            used: formatTokenCount(usedTokens),
            max: formatTokenCount(maxTokens),
          })}
        </Text>
        {sessionCost ? (
          <Text style={styles.detail}>{t("contextWindow.sessionCost", { cost: sessionCost })}</Text>
        ) : null}
      </View>
      <AgentUsage serverId={serverId} agentId={agentId} refreshable={refreshable} />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  summary: {
    gap: theme.spacing[1.5],
    minWidth: 200,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
