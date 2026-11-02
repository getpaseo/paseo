import type { Logger } from "pino";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { AgentManager } from "../../agent-manager.js";
import type { AgentStorage } from "../../agent-storage.js";
import type { AgentMessageDelivery } from "../../agent-messages/index.js";
import { buildStoredAgentPayload, toAgentPayload } from "../../agent-projections.js";
import { serializeSnapshotWithMetadata } from "../../mcp-shared.js";
import { createHostObservationResolver, type ToolHosts } from "../../host-operations/index.js";
import { openFinishObservation } from "./observation-stream.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { FinishObservation } from "../index.js";

export function createFinishObservation(input: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  /** A child chosen for restart recovery reports its state only after its resume was sent. */
  waitForResume(agentId: string, signal: AbortSignal): Promise<void>;
  messages(): AgentMessageDelivery;
  hosts(): ToolHosts;
  serverId: string;
  logger: Logger;
}): FinishObservation {
  const { agentManager, agentStorage } = input;
  async function recorded(agentId: string): Promise<WaitForFinishResult> {
    const stored = await agentStorage.get(agentId);
    return {
      status: stored?.lastStatus === "error" ? "error" : "idle",
      final: stored ? buildStoredAgentPayload(stored, [stored.provider]) : null,
      lastMessage: await agentManager.getLastAssistantMessage(agentId),
      error: stored?.lastError ?? null,
    };
  }
  const resolver = createHostObservationResolver({
    serverId: input.serverId,
    hosts: input.hosts,
    local: {
      async wait(agentId, signal) {
        await input.waitForResume(agentId, signal);
        await input.messages().waitForDispatch(agentId, signal);
        signal.throwIfAborted();
        if (!agentManager.getAgent(agentId)) return await recorded(agentId);
        const result = await agentManager.waitForAgentEvent(agentId, {
          signal,
          waitForActive: true,
        });
        const current = agentManager.getAgent(agentId);
        // A runtime closed during the wait keeps its record; only a removed child has none.
        if (!current) return await recorded(agentId);
        const status = result.permission ? "permission" : result.status;
        return {
          status: status === "permission" || status === "error" ? status : "idle",
          final: await serializeSnapshotWithMetadata(agentStorage, current, input.logger),
          lastMessage: result.lastMessage,
          error: current.lastError ?? null,
        };
      },
      async observe(agentId, handler, signal, onError) {
        await input.waitForResume(agentId, signal);
        const stored = await agentStorage.get(agentId);
        let updates = Promise.resolve();
        const publish = (
          snapshot: AgentSnapshotPayload | null | (() => Promise<AgentSnapshotPayload>),
          event?: AgentStreamEvent,
        ) => {
          updates = updates
            .then(async () =>
              handler(
                typeof snapshot === "function" ? await snapshot() : snapshot,
                event,
                await agentManager.getLastAssistantMessage(agentId),
              ),
            )
            .catch(onError);
        };
        signal.throwIfAborted();
        const unsubscribe = agentManager.subscribe(
          (event) => {
            if (event.type === "agent_state" && event.agent.lifecycle === "closed") {
              const { agent } = event;
              // Idle cleanup and reloads close runtimes too. Only the record says archived.
              publish(async () =>
                toAgentPayload(agent, {
                  title: stored?.title,
                  archivedAt: (await agentStorage.get(agentId))?.archivedAt,
                }),
              );
            } else if (event.type === "agent_state" && event.agent.lifecycle !== "idle")
              publish(toAgentPayload(event.agent, { title: stored?.title }));
            else if (event.type === "agent_removed") publish(null);
            else if (
              event.type === "agent_stream" &&
              [
                "permission_requested",
                "permission_resolved",
                "turn_started",
                "turn_completed",
                "turn_canceled",
                "turn_failed",
              ].includes(event.event.type)
            ) {
              const current = agentManager.getAgent(agentId);
              if (current) publish(toAgentPayload(current, { title: stored?.title }), event.event);
            }
          },
          { agentId, replayState: false },
        );
        const current = agentManager.getAgent(agentId);
        if (current)
          publish(toAgentPayload(current, { title: stored?.title }), {
            type: "turn_started",
            provider: current.provider,
          });
        // Without a runtime, a stored running status is a close not yet written. No run is in flight.
        else if (stored?.lastStatus !== "running")
          publish(stored ? buildStoredAgentPayload(stored, [stored.provider]) : null);
        const stop = () => unsubscribe();
        signal.addEventListener("abort", stop, { once: true });
        return async () => {
          signal.removeEventListener("abort", stop);
          unsubscribe();
        };
      },
    },
  });
  return { open: (record, signal) => openFinishObservation(resolver, record, signal) };
}
