import type pino from "pino";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import type { ManagedAgent } from "../agent/agent-manager.js";

export const CHAT_MENTION_FANOUT_LIMIT = 25;

export interface ChatMentionNotificationInput {
  room: string;
  authorAgentId: string;
  body: string;
  mentionAgentIds: string[];
}

export interface NotifyChatMentionsInput extends ChatMentionNotificationInput {
  logger: pino.Logger;
  listStoredAgents: () => Promise<StoredAgentRecord[]>;
  listLiveAgents: () => ManagedAgent[];
  listRoomPosterAgentIds: () => Promise<string[]>;
  resolveAgentIdentifier: (
    identifier: string,
  ) => Promise<{ ok: true; agentId: string } | { ok: false; error: string }>;
  sendAgentMessage: (agentId: string, text: string) => Promise<void>;
}

export async function notifyChatMentions(input: NotifyChatMentionsInput): Promise<void> {
  const storedAgents = await input.listStoredAgents();
  const liveAgents = input.listLiveAgents();
  const mentionAgentIds = await resolveChatMentionTargetAgentIds({
    authorAgentId: input.authorAgentId,
    mentionAgentIds: input.mentionAgentIds,
    storedAgents,
    liveAgents,
    roomPosterAgentIds: await input.listRoomPosterAgentIds(),
  });
  if (mentionAgentIds.length === 0) {
    return;
  }

  const notification = buildChatMentionNotification({
    room: input.room,
    authorAgentId: input.authorAgentId,
    body: input.body,
    mentionAgentIds,
  });

  await Promise.all(
    mentionAgentIds.map(async (mentionedAgentId) => {
      const resolved = await input.resolveAgentIdentifier(mentionedAgentId);
      if (!resolved.ok) {
        input.logger.warn(
          { mentionedAgentId, room: input.room, error: resolved.error },
          "Failed to resolve chat mention target",
        );
        return;
      }

      if (
        !isChatMentionTargetEligible({
          agentId: resolved.agentId,
          authorAgentId: input.authorAgentId,
          storedAgents,
          liveAgents,
        })
      ) {
        return;
      }

      try {
        await input.sendAgentMessage(resolved.agentId, notification);
      } catch (error) {
        input.logger.warn(
          { err: error, mentionedAgentId: resolved.agentId, room: input.room },
          "Failed to notify mentioned agent about chat message",
        );
      }
    }),
  );
}

export function resolveChatMentionTargetAgentIds(input: {
  authorAgentId: string;
  mentionAgentIds: string[];
  storedAgents: StoredAgentRecord[];
  liveAgents: ManagedAgent[];
  roomPosterAgentIds: string[];
}): string[] {
  const targets = new Set<string>();
  const mentionsEveryone = input.mentionAgentIds.includes("everyone");

  for (const mentionAgentId of input.mentionAgentIds) {
    if (mentionAgentId === "everyone") {
      continue;
    }
    if (mentionAgentId !== input.authorAgentId) {
      targets.add(mentionAgentId);
    }
  }

  if (!mentionsEveryone) {
    return filterEligibleKnownMentionTargets({
      authorAgentId: input.authorAgentId,
      targetAgentIds: targets,
      storedAgents: input.storedAgents,
      liveAgents: input.liveAgents,
    });
  }

  for (const posterAgentId of input.roomPosterAgentIds) {
    if (posterAgentId === input.authorAgentId) {
      continue;
    }
    targets.add(posterAgentId);
  }

  return filterEligibleKnownMentionTargets({
    authorAgentId: input.authorAgentId,
    targetAgentIds: targets,
    storedAgents: input.storedAgents,
    liveAgents: input.liveAgents,
  });
}

export function validateChatMentionFanout(input: {
  mentionAgentIds: string[];
  resolvedMentionAgentIds: string[];
  limit?: number;
}): { ok: true } | { ok: false; error: string } {
  const limit = input.limit ?? CHAT_MENTION_FANOUT_LIMIT;
  if (
    !input.mentionAgentIds.includes("everyone") ||
    input.resolvedMentionAgentIds.length <= limit
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    error: `@everyone would notify ${input.resolvedMentionAgentIds.length} agents, which exceeds the limit of ${limit}. Narrow the room or mention specific agents.`,
  };
}

function filterEligibleKnownMentionTargets(input: {
  authorAgentId: string;
  targetAgentIds: Set<string>;
  storedAgents: StoredAgentRecord[];
  liveAgents: ManagedAgent[];
}): string[] {
  const targets: string[] = [];
  for (const targetAgentId of input.targetAgentIds) {
    if (
      isChatMentionTargetEligible({
        agentId: targetAgentId,
        authorAgentId: input.authorAgentId,
        storedAgents: input.storedAgents,
        liveAgents: input.liveAgents,
      })
    ) {
      targets.push(targetAgentId);
    }
  }
  return targets;
}

function isChatMentionTargetEligible(input: {
  agentId: string;
  authorAgentId: string;
  storedAgents: StoredAgentRecord[];
  liveAgents: ManagedAgent[];
}): boolean {
  if (input.agentId === input.authorAgentId) {
    return false;
  }

  const stored = input.storedAgents.find((record) => record.id === input.agentId);
  if (stored?.internal || stored?.archivedAt || stored?.lastStatus === "error") {
    return false;
  }

  const live = input.liveAgents.find((agent) => agent.id === input.agentId);
  if (live) {
    return !live.internal && live.lifecycle !== "error";
  }

  if (stored) {
    return true;
  }

  return true;
}

export function buildChatMentionNotification(input: ChatMentionNotificationInput): string {
  const mentioned = input.mentionAgentIds.map((agentId) => `@${agentId}`).join(", ");
  const bodyWithoutMentions = input.body.replace(/(^|\s)@[A-Za-z0-9][A-Za-z0-9._-]*/g, "$1").trim();
  const body = bodyWithoutMentions.length > 0 ? bodyWithoutMentions : input.body;

  return [
    `Chat mention from ${input.authorAgentId} in room "${input.room}".`,
    `Mentioned agents: ${mentioned}.`,
    "Message:",
    body,
    `Read the room with: paseo chat read ${input.room} --limit 20`,
  ].join("\n");
}
