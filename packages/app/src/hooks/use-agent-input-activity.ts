import { useCallback, useRef } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export function useAgentInputActivity(input: {
  client: DaemonClient | null;
  agentId: string;
  requestId?: string;
}) {
  const reported = useRef<{ at: number } | null>(null);
  const target = useRef(input);
  if (
    target.current.client !== input.client ||
    target.current.agentId !== input.agentId ||
    target.current.requestId !== input.requestId
  ) {
    target.current = input;
    reported.current = null;
  }

  const notify = useCallback(
    (kind: "focus" | "typing") => {
      const { client, agentId, requestId } = input;
      // COMPAT(agentInputActivity): added in v0.10.0, remove after 2027-04-03 once daemon floor supports input activity.
      if (
        !client?.isConnected ||
        !agentId ||
        client.getLastServerInfoMessage()?.features?.agentInputActivity !== true
      )
        return;
      const activity = { at: Date.now() };
      if (
        reported.current &&
        (requestId || kind === "focus" || activity.at - reported.current.at < 1000)
      )
        return;
      reported.current = activity;
      void client.notifyAgentInputActivity(agentId, { requestId, kind }).catch((error) => {
        if (reported.current === activity) reported.current = null;
        console.error("Failed to report agent input activity", error);
      });
    },
    [input.client, input.agentId, input.requestId],
  );

  const onFocusChange = useCallback(
    (focused: boolean) => {
      if (focused) notify("focus");
      else reported.current = null;
    },
    [notify],
  );

  return { notify, onFocusChange };
}
