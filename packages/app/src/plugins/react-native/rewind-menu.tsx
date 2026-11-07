import { useCallback } from "react";
import { RewindMenu, type RewindMode } from "@/components/rewind/rewind-menu";
import { useRewindAgentMutation } from "@/components/rewind/use-rewind-agent-mutation";
import { useSessionStore } from "@/stores/session-store";
import { selectPluginRewindCapabilities } from "./rewind-target";

export type PluginRewindMenuProps = import("@getpaseo/plugin/client/ui").RewindMenuProps;

/**
 * The host's own rewind menu for a prompt a plugin draws. The menu offers the
 * modes the agent's provider declares (Claude: conversation, files, both;
 * Codex, OMP and Pi: conversation; OpenCode: both; none for ACP) and the
 * rewind runs through the same mutation as the host bubble: the timeline is
 * refetched and a conversation rewind restores the prompt to the composer.
 */
export function PluginRewindMenu({ hostId, agentId, messageId, text }: PluginRewindMenuProps) {
  const client = useSessionStore((state) => state.sessions[hostId]?.client ?? null);
  const capabilities = useSessionStore((state) =>
    selectPluginRewindCapabilities(state.sessions, hostId, agentId),
  );
  const mutation = useRewindAgentMutation({ serverId: hostId, agentId, client, messageId });
  const { rewindAgent } = mutation;
  const handleRewind = useCallback(
    (input: { mode: RewindMode; rewoundText: string }) => rewindAgent(input),
    [rewindAgent],
  );

  if (!capabilities || !messageId) return null;
  return (
    <RewindMenu
      capabilities={capabilities}
      rewoundText={text}
      isPending={mutation.isPending}
      onRewind={handleRewind}
    />
  );
}
