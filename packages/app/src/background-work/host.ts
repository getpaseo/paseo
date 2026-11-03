import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { createBackgroundWorkModel } from "./model";

export function createHostBackgroundWorkModel(serverId: string, agentId: string) {
  const host = getHostRuntimeStore();
  let client: DaemonClient | null = null;
  return createBackgroundWorkModel({
    list: () => {
      if (!client) return Promise.reject(new Error("Host disconnected"));
      return client.listAgentBackgroundWork(agentId);
    },
    observe: ({ snapshot, update, disconnected, failed }) => {
      let release: (() => void) | undefined;
      const sync = () => {
        const next = host.getSnapshot(serverId)?.client ?? null;
        if (next === client) return;
        const previousRelease = release;
        client = next;
        release = undefined;
        disconnected();
        previousRelease?.();
        if (!client) return;
        // COMPAT(agentBackgroundWork): added after v0.11.0-beta.5, remove gate after 2027-04-06.
        if (client.getLastServerInfoMessage()?.features?.agentBackgroundWork !== true) {
          failed();
          return;
        }
        const observedClient = client;
        const observation = client.observeAgentBackgroundWork();
        observation.subscribe({
          snapshot: () => {
            if (client === observedClient) snapshot();
          },
          update: (message) => {
            if (
              client === observedClient &&
              message.type === "agent.background_work.update" &&
              message.payload.agentId === agentId
            )
              update(message.payload.items);
          },
        });
        release = () => {
          void observation
            .release()
            .catch((error: unknown) =>
              console.error("Background work subscription cleanup failed", error),
            );
        };
      };
      const unsubscribe = host.subscribe(serverId, sync);
      sync();
      return () => {
        unsubscribe();
        client = null;
        release?.();
      };
    },
  });
}
