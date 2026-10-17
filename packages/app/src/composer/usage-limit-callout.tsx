import { useMutation } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  AUTO_RESUME_USAGE_LIMIT_LABEL,
  usageLimitResumeAt,
} from "@getpaseo/protocol/agent-usage-limit";
import { Switch } from "@/components/ui/switch";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { toErrorMessage } from "@/utils/error-messages";

interface UsageLimitCalloutProps {
  serverId: string;
  agentId?: string;
}

export function UsageLimitCallout({ serverId, agentId }: UsageLimitCalloutProps) {
  const { t, i18n } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  // COMPAT(usageLimitResume): added in v0.12.0; remove gate after 2027-04-17.
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.usageLimitResume === true,
  );
  const limit = useSessionStore((state) =>
    agentId ? state.sessions[serverId]?.agents.get(agentId)?.usageLimit : undefined,
  );
  const enabled = useSessionStore((state) =>
    agentId
      ? state.sessions[serverId]?.agents.get(agentId)?.labels[AUTO_RESUME_USAGE_LIMIT_LABEL] ===
        "true"
      : false,
  );
  const mutation = useMutation({
    mutationFn: async (value: boolean) => {
      if (!client || !agentId) throw new Error("Agent is unavailable");
      await client.updateAgent(agentId, {
        labels: { [AUTO_RESUME_USAGE_LIMIT_LABEL]: String(value) },
      });
    },
  });
  if (!supported || (!limit && !enabled)) return null;

  const resumeAt = limit ? usageLimitResumeAt(limit) : null;
  const missingReset = Boolean(limit && resumeAt === null);
  let description = t("agentPanel.usageLimit.enabled");
  if (missingReset) description = t("agentPanel.usageLimit.unknownReset");
  if (resumeAt !== null) {
    const at = new Date(resumeAt).toLocaleString(i18n.language, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    description = t(
      enabled ? "agentPanel.usageLimit.scheduled" : "agentPanel.usageLimit.available",
      { at },
    );
  }

  return (
    <View style={styles.container} testID="usage-limit-callout">
      <View style={styles.row}>
        <View style={styles.copy}>
          <Text style={styles.title}>{t("agentPanel.usageLimit.label")}</Text>
          <View>
            <Text
              style={[styles.description, mutation.isPending && styles.hidden]}
              accessibilityElementsHidden={mutation.isPending}
              importantForAccessibility={mutation.isPending ? "no-hide-descendants" : "auto"}
            >
              {description}
            </Text>
            {mutation.isPending ? (
              <Text style={[styles.description, styles.saving]}>
                {t("agentPanel.usageLimit.saving")}
              </Text>
            ) : null}
          </View>
        </View>
        <Switch
          testID="usage-limit-auto-resume"
          accessibilityLabel={t("agentPanel.usageLimit.label")}
          value={mutation.isPending ? mutation.variables : enabled}
          disabled={!isConnected || mutation.isPending || (missingReset && !enabled)}
          onValueChange={mutation.mutate}
        />
      </View>
      {mutation.isError ? <Text style={styles.error}>{toErrorMessage(mutation.error)}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    padding: theme.spacing[3],
    marginBottom: theme.spacing[2],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    gap: theme.spacing[2],
  },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  copy: { flex: 1, gap: theme.spacing[1] },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  hidden: { opacity: 0 },
  saving: { position: "absolute", top: 0, left: 0, right: 0 },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
