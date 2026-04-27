import type pino from "pino";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import type { ManagedAgent } from "../agent/agent-manager.js";

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
  resolveAgentIdentifier: (
    identifier: string,
  ) => Promise<{ ok: true; agentId: string } | { ok: false; error: string }>;
  sendAgentMessage: (agentId: string, text: string) => Promise<void>;
}

export async function notifyChatMentions(input: NotifyChatMentionsInput): Promise<void> {
  const mentionAgentIds = await resolveChatMentionTargetAgentIds({
    authorAgentId: input.authorAgentId,
    mentionAgentIds: input.mentionAgentIds,
    storedAgents: await input.listStoredAgents(),
    liveAgents: input.listLiveAgents(),
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
    return Array.from(targets);
  }

  for (const record of input.storedAgents) {
    if (record.internal || record.archivedAt || record.id === input.authorAgentId) {
      continue;
    }
    targets.add(record.id);
  }

  for (const agent of input.liveAgents) {
    if (agent.internal || agent.id === input.authorAgentId) {
      continue;
    }
    targets.add(agent.id);
  }

  return Array.from(targets);
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
    `Read the room with: hubcode chat read ${input.room} --limit 20`,
  ].join("\n");
}
