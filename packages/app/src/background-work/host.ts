import type { PaseoAgentBackgroundWorkItem } from "@getpaseo/client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { createBackgroundWorkModel } from "./model";

interface BackgroundWorkClient {
  getLastServerInfoMessage(): {
    features?: { agentBackgroundWork?: boolean; agentBackgroundWorkStop?: boolean } | null;
  } | null;
  stopAgentBackgroundWork(agentId: string, item: PaseoAgentBackgroundWorkItem): Promise<void>;
  listAgentBackgroundWork(agentId: string): Promise<PaseoAgentBackgroundWorkItem[]>;
  observeAgentBackgroundWork(): {
    subscribe(observer: {
      snapshot(): void;
      update(message: SessionOutboundMessage): void;
      error(error: unknown): void;
    }): unknown;
    release(): Promise<void>;
  };
}

interface BackgroundWorkHost {
  getClient(): BackgroundWorkClient | null;
  subscribe(listener: () => void): () => void;
}

function hostFor(serverId: string): BackgroundWorkHost {
  const host = getHostRuntimeStore();
  return {
    getClient: () => host.getSnapshot(serverId)?.client ?? null,
    subscribe: (listener) => host.subscribe(serverId, listener),
  };
}

export function createHostBackgroundWorkModel(
  serverId: string,
  agentId: string,
  host: BackgroundWorkHost = hostFor(serverId),
) {
  let client: BackgroundWorkClient | null = null;
  const controls = (items: PaseoAgentBackgroundWorkItem[]) => {
    // COMPAT(agentBackgroundWorkStop): added after v0.15.0, remove after 2027-05-03.
    if (client?.getLastServerInfoMessage()?.features?.agentBackgroundWorkStop === true)
      return items;
    return items.map(({ canStop: _canStop, stopToken: _stopToken, ...item }) => item);
  };
  return createBackgroundWorkModel({
    stop: (item) => {
      if (!client) return Promise.reject(new Error("Host disconnected"));
      return client.stopAgentBackgroundWork(agentId, item);
    },
    list: () => {
      if (!client) return Promise.reject(new Error("Host disconnected"));
      return client.listAgentBackgroundWork(agentId).then(controls);
    },
    observe: ({ snapshot, update, disconnected, failed }) => {
      let release: (() => void) | undefined;
      let currentObservation:
        | ReturnType<BackgroundWorkClient["observeAgentBackgroundWork"]>
        | undefined;
      const sync = () => {
        const candidate = host.getClient();
        // The runtime keeps the client across reconnects, but clears server info until handshake.
        const next = candidate?.getLastServerInfoMessage() ? candidate : null;
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
        currentObservation = observation;
        observation.subscribe({
          snapshot: () => {
            if (client === observedClient && currentObservation === observation) snapshot();
          },
          update: (message) => {
            if (
              client === observedClient &&
              currentObservation === observation &&
              message.type === "agent.background_work.update" &&
              message.payload.agentId === agentId
            )
              update(controls(message.payload.items));
          },
          error: () => {
            if (client === observedClient && currentObservation === observation) failed();
          },
        });
        release = () => {
          if (currentObservation === observation) currentObservation = undefined;
          void observation
            .release()
            .catch((error: unknown) =>
              console.error("Background work subscription cleanup failed", error),
            );
        };
      };
      const unsubscribe = host.subscribe(sync);
      sync();
      return () => {
        unsubscribe();
        client = null;
        release?.();
      };
    },
  });
}
