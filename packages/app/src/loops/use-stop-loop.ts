import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { refreshLoops } from "./store";

export function useStopLoop(input: { serverId: string }): {
  stopLoop: (loopId: string) => void;
  stoppingLoopIds: ReadonlySet<string>;
} {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  const [stoppingLoopIds, setStoppingLoopIds] = useState<Set<string>>(() => new Set());

  const stopLoop = useCallback(
    (loopId: string) => {
      if (!client) {
        toast.error(t("common.errors.daemonClientUnavailable"));
        return;
      }
      setStoppingLoopIds((current) => {
        const next = new Set(current);
        next.add(loopId);
        return next;
      });
      void client
        .loopStop(loopId)
        .then(async (payload) => {
          if (payload.error) {
            toast.error(payload.error);
            return undefined;
          }
          await refreshLoops(client, input.serverId).catch(() => undefined);
          return undefined;
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : t("loops.stopFailed");
          toast.error(message);
        })
        .finally(() => {
          setStoppingLoopIds((current) => {
            const next = new Set(current);
            next.delete(loopId);
            return next;
          });
        });
    },
    [client, input.serverId, t, toast],
  );

  return { stopLoop, stoppingLoopIds };
}
