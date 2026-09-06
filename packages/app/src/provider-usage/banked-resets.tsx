import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CodexBankedReset,
  CodexBankedResets,
  CodexBankedResetOutcome,
} from "@getpaseo/protocol/messages";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { providerUsageQueryKey } from "./use-provider-usage";

const outcomeCopy: Record<CodexBankedResetOutcome, string> = {
  reset: "Banked reset used. Codex usage limits have been reset.",
  nothing_to_reset: "There is no usage to reset. Your banked reset was not used.",
  no_credit: "This banked reset is no longer available.",
  already_redeemed: "This banked reset has already been used.",
};

interface ConsumeResetInput {
  creditId: string;
  idempotencyKey: string;
}

function resetErrorMessage(error: Error): string {
  if (error.name !== "DaemonRpcError") return error.message;
  return error.message.replace(/ requestType=\S+(?: code=\S+)?$/, "");
}

function resetStatus(credit: CodexBankedReset): string {
  if (credit.status === "redeemed") return "Used";
  if (credit.status === "redeeming") return "Processing";
  if (credit.expiresAt && Date.parse(credit.expiresAt) <= Date.now()) return "Expired";
  if (credit.supportedByPlan === false) return "Not supported by plan";
  if (credit.resetType !== "codex_rate_limits") return "Unsupported";
  return credit.status === "available" ? "Available" : "Unavailable";
}

export function CodexBankedResetManagement({
  serverId,
  resets,
}: {
  serverId: string;
  resets: CodexBankedResets | undefined;
}) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  // COMPAT(codexBankedResets): added in v0.7.3, remove after 2027-03-06 once daemon floor >= v0.7.3.
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.codexBankedResets === true,
  );
  const queryClient = useQueryClient();
  const mutation = useMutation({
    retry: false,
    mutationFn: async (input: ConsumeResetInput) => {
      if (!client || !connected) throw new Error("Reconnect to this host to use a banked reset.");
      const confirmed = await confirmDialog({
        title: "Use banked reset?",
        message:
          "This spends the selected banked reset to reset your Codex usage limits. It cannot be undone.",
        confirmLabel: "Use reset",
      });
      if (!confirmed) return null;
      return client.consumeCodexBankedReset(input);
    },
    onSettled: async (result) => {
      if (result === null) return;
      await queryClient.invalidateQueries({ queryKey: providerUsageQueryKey(serverId) });
    },
  });

  const { mutate, variables, isError } = mutation;
  const consume = useCallback(
    (creditId: string) => {
      const previous = variables;
      const retrying = isError && previous?.creditId === creditId;
      const input = retrying ? previous : { creditId, idempotencyKey: crypto.randomUUID() };
      mutate(input);
    },
    [variables, isError, mutate],
  );

  const retry = useCallback(() => {
    if (variables) mutate(variables);
  }, [variables, mutate]);

  if (!resets && mutation.isIdle) return null;

  if (!supported) {
    return <Text style={styles.muted}>Update this host to manage banked resets.</Text>;
  }

  return (
    <View style={styles.container}>
      {resets?.error ? <Alert variant="error" description={resets.error} /> : null}
      {resets?.credits?.map((credit) => (
        <BankedResetRow
          key={credit.id}
          credit={credit}
          connected={connected}
          pendingCreditId={mutation.isPending ? mutation.variables.creditId : null}
          onConsume={consume}
        />
      ))}
      {mutation.isError ? (
        <Alert
          variant="error"
          title="Could not use banked reset"
          description={resetErrorMessage(mutation.error)}
        >
          <Button variant="outline" size="sm" disabled={!connected} onPress={retry}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {mutation.data ? (
        <Alert
          variant={mutation.data.outcome === "reset" ? "success" : "info"}
          description={outcomeCopy[mutation.data.outcome]}
        />
      ) : null}
      {!connected ? (
        <Text style={styles.muted}>Reconnect to this host to use a banked reset.</Text>
      ) : null}
    </View>
  );
}

function BankedResetRow({
  credit,
  connected,
  pendingCreditId,
  onConsume,
}: {
  credit: CodexBankedReset;
  connected: boolean;
  pendingCreditId: string | null;
  onConsume: (creditId: string) => void;
}) {
  const onPress = useCallback(() => onConsume(credit.id), [credit.id, onConsume]);
  const status = resetStatus(credit);
  const available = status === "Available";
  const disabled = !connected || pendingCreditId !== null;
  const loading = pendingCreditId === credit.id;
  const expires = credit.expiresAt
    ? `Expires ${new Date(credit.expiresAt).toLocaleString()}`
    : "No expiration";
  return (
    <View style={styles.row}>
      <View style={styles.description}>
        <Text style={styles.title}>{credit.title ?? "Codex usage reset"}</Text>
        {credit.description ? <Text style={styles.muted}>{credit.description}</Text> : null}
        <Text style={styles.muted}>{expires}</Text>
      </View>
      {available ? (
        <Button variant="outline" size="sm" disabled={disabled} loading={loading} onPress={onPress}>
          Use reset
        </Button>
      ) : (
        <StatusBadge label={status} variant="muted" />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[3] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  description: { flex: 1, gap: theme.spacing[1] },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
