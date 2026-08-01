import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";

export function useStopBackgroundTask(input: { serverId: string; parentAgentId: string }): {
  stopTask: (taskId: string) => void;
  stoppingTaskIds: ReadonlySet<string>;
} {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  const [stoppingTaskIds, setStoppingTaskIds] = useState<Set<string>>(() => new Set());

  const stopTask = useCallback(
    (taskId: string) => {
      if (!client) {
        toast.error(t("common.errors.daemonClientUnavailable"));
        return;
      }
      setStoppingTaskIds((current) => {
        const next = new Set(current);
        next.add(taskId);
        return next;
      });
      void client
        .stopBackgroundTask(input.parentAgentId, taskId)
        .catch((error) => {
          const message = error instanceof Error ? error.message : t("backgroundTasks.stopFailed");
          toast.error(message);
        })
        .finally(() => {
          setStoppingTaskIds((current) => {
            const next = new Set(current);
            next.delete(taskId);
            return next;
          });
        });
    },
    [client, input.parentAgentId, t, toast],
  );

  return { stopTask, stoppingTaskIds };
}
