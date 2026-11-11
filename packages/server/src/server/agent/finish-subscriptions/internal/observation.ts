import type { Logger } from "pino";
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
  messages(): AgentMessageDelivery;
  hosts(): ToolHosts;
  serverId: string;
  logger: Logger;
}): FinishObservation {
  const { agentManager, agentStorage } = input;
  const resolver = createHostObservationResolver({
    serverId: input.serverId,
    hosts: input.hosts,
    local: {
      async wait(agentId, signal) {
        await input.messages().waitForDispatch(agentId, signal);
        signal.throwIfAborted();
        const live = agentManager.getAgent(agentId);
        if (!live) {
          const stored = await agentStorage.get(agentId);
          return {
            status: stored?.lastStatus === "error" ? "error" : "idle",
            final: stored ? buildStoredAgentPayload(stored, [stored.provider]) : null,
            lastMessage: await agentManager.getLastAssistantMessage(agentId),
            error: stored?.lastError ?? null,
          };
        }
        const result = await agentManager.waitForAgentEvent(agentId, {
          signal,
          waitForActive: true,
        });
        const current = agentManager.getAgent(agentId);
        const status = result.permission ? "permission" : result.status;
        return {
          status: status === "permission" || status === "error" ? status : "idle",
          final: current
            ? await serializeSnapshotWithMetadata(agentStorage, current, input.logger)
            : null,
          lastMessage: result.lastMessage,
          error: current?.lastError ?? null,
        };
      },
      async observe(agentId, handler, signal, onError) {
        const stored = await agentStorage.get(agentId);
        let updates = Promise.resolve();
        const publish = (snapshot: AgentSnapshotPayload | null, event?: AgentStreamEvent) => {
          updates = updates
            .then(async () =>
              handler(snapshot, event, await agentManager.getLastAssistantMessage(agentId)),
            )
            .catch(onError);
        };
        signal.throwIfAborted();
        const unsubscribe = agentManager.subscribe(
          (event) => {
            if (event.type === "agent_state" && event.agent.lifecycle !== "idle")
              publish(toAgentPayload(event.agent, { title: stored?.title }));
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
        else publish(stored ? buildStoredAgentPayload(stored, [stored.provider]) : null);
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
