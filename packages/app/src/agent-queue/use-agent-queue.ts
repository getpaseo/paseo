import { useEffect } from "react";
import type { AgentQueuedPromptPayload } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";

const EMPTY_PROMPTS: AgentQueuedPromptPayload[] = [];

export function useAgentQueuePrompts(input: {
  serverId: string;
  agentId: string;
}): AgentQueuedPromptPayload[] {
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  const supported = useSessionStore(
    (state) => state.sessions[input.serverId]?.serverInfo?.features?.agentQueue === true,
  );
  const prompts = useSessionStore(
    (state) =>
      state.sessions[input.serverId]?.agentQueuePrompts.get(input.agentId) ?? EMPTY_PROMPTS,
  );
  const setPrompts = useSessionStore((state) => state.setAgentQueuePrompts);

  useEffect(() => {
    if (!client || !supported) return;
    void client
      .listAgentQueue(input.agentId)
      .then((payload) => {
        if (!payload.error) setPrompts(input.serverId, input.agentId, payload.prompts);
        return undefined;
      })
      .catch(() => undefined);
  }, [client, input.agentId, input.serverId, setPrompts, supported]);

  return supported ? prompts : EMPTY_PROMPTS;
}
