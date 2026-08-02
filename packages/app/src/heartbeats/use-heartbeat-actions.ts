import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { schedulesQueryBaseKey } from "@/schedules/aggregated-schedules";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { refreshProviderHeartbeats } from "./provider-store";
import type { HeartbeatRow } from "./select";

export function useHeartbeatActions(input: { serverId: string; parentAgentId: string }): {
  pauseHeartbeat: (id: string) => void;
  resumeHeartbeat: (id: string) => void;
  deleteHeartbeat: (row: HeartbeatRow) => void;
  pendingIds: ReadonlySet<string>;
} {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());

  const markPending = useCallback((id: string, pending: boolean) => {
    setPendingIds((current) => {
      const next = new Set(current);
      if (pending) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const invalidatePaseoSchedules = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: schedulesQueryBaseKey });
  }, [queryClient]);

  const pauseHeartbeat = useCallback(
    (id: string) => {
      if (!client) {
        toast.error(t("common.errors.daemonClientUnavailable"));
        return;
      }
      markPending(id, true);
      void client
        .schedulePause({ id })
        .then((payload) => {
          if (payload.error) {
            toast.error(payload.error);
            return undefined;
          }
          invalidatePaseoSchedules();
          return undefined;
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : t("heartbeats.pauseFailed");
          toast.error(message);
        })
        .finally(() => {
          markPending(id, false);
        });
    },
    [client, invalidatePaseoSchedules, markPending, t, toast],
  );

  const resumeHeartbeat = useCallback(
    (id: string) => {
      if (!client) {
        toast.error(t("common.errors.daemonClientUnavailable"));
        return;
      }
      markPending(id, true);
      void client
        .scheduleResume({ id })
        .then((payload) => {
          if (payload.error) {
            toast.error(payload.error);
            return undefined;
          }
          invalidatePaseoSchedules();
          return undefined;
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : t("heartbeats.resumeFailed");
          toast.error(message);
        })
        .finally(() => {
          markPending(id, false);
        });
    },
    [client, invalidatePaseoSchedules, markPending, t, toast],
  );

  const deleteHeartbeat = useCallback(
    (row: HeartbeatRow) => {
      if (!client) {
        toast.error(t("common.errors.daemonClientUnavailable"));
        return;
      }

      void (async () => {
        const label = rowLabel(row);
        const confirmed = await confirmDialog({
          title: t("heartbeats.deleteTitle"),
          message: t("heartbeats.deleteMessage", { label }),
          confirmLabel: t("heartbeats.deleteConfirm"),
          destructive: true,
        });
        if (!confirmed) {
          return;
        }

        markPending(row.id, true);
        try {
          if (row.kind === "paseo") {
            const payload = await client.scheduleDelete({ id: row.id });
            if (payload.error) {
              toast.error(payload.error);
              return;
            }
            invalidatePaseoSchedules();
            return;
          }

          const payload = await client.deleteProviderHeartbeat(row.parentAgentId, row.id);
          if (payload.error) {
            // Advisory cancel limitation: still refresh so the row disappears from
            // Paseo's view when the server removed it.
            toast.error(payload.error);
          }
          await refreshProviderHeartbeats(client, input.serverId, input.parentAgentId).catch(
            () => undefined,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : t("heartbeats.deleteFailed");
          toast.error(message);
        } finally {
          markPending(row.id, false);
        }
      })();
    },
    [client, input.parentAgentId, input.serverId, invalidatePaseoSchedules, markPending, t, toast],
  );

  return {
    pauseHeartbeat,
    resumeHeartbeat,
    deleteHeartbeat,
    pendingIds,
  };
}

function rowLabel(row: HeartbeatRow): string {
  if (row.kind === "paseo") {
    const name = row.name?.trim();
    if (name) return name;
    const prompt = row.prompt.trim();
    if (prompt) return prompt;
    return row.id;
  }
  const prompt = row.prompt.trim();
  if (prompt) return prompt;
  return row.id;
}
