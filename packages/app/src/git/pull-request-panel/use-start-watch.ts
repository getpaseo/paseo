import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

export function useStartPrWatch(serverId: string, url: string, abbreviation: string) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  // COMPAT(agentChangeRequestSubscribe): added after v0.17.4, remove after 2027-05-25.
  const supported = useHostFeature(serverId, "agentChangeRequestSubscribe");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);

  const start = useCallback(
    async (agentId: string) => {
      if (submitting.current || !supported) return false;
      if (!client) {
        setError(t("workspace.git.pr.watch.disconnected"));
        return false;
      }
      submitting.current = true;
      setPending(true);
      setError(null);
      try {
        if (!(await client.subscribeAgentChangeRequest({ agentId, url }))) {
          setError(t("workspace.git.pr.watch.closed", { abbreviation }));
          return false;
        }
        toast.show(t("workspace.git.pr.watch.started"), { variant: "success" });
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t("workspace.git.pr.watch.failed"));
        return false;
      } finally {
        submitting.current = false;
        setPending(false);
      }
    },
    [abbreviation, client, supported, t, toast, url],
  );

  return { supported, pending, error, setError, start };
}
