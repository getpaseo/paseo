import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { Logger } from "pino";

import type {
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../agent-sdk-types.js";
import { ACPAgentSession, type ACPAgentSessionOptions } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface TraeACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

const TRAE_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;

export class TraeACPAgentClient extends GenericACPAgentClient {
  constructor(options: TraeACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      // traecli publishes slash commands and skills asynchronously via available_commands_update.
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: TRAE_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
    });
  }

  protected override createSessionInstance(
    config: AgentSessionConfig,
    options: ACPAgentSessionOptions,
  ): ACPAgentSession {
    return new TraeACPAgentSession(config, options);
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readTraeMeta(meta: unknown): Record<string, unknown> | null {
  return readRecord(readRecord(meta)?.traex);
}

function childTimelineItem(
  update: SessionNotification["update"],
  childTurnId: string | undefined,
): AgentTimelineItem | null {
  if (
    update.sessionUpdate !== "agent_message_chunk" &&
    update.sessionUpdate !== "agent_thought_chunk"
  ) {
    return null;
  }
  if (update.content.type !== "text" || update.content.text.length === 0) return null;
  if (update.sessionUpdate === "agent_thought_chunk") {
    return { type: "reasoning", text: update.content.text };
  }
  const messageId = update.messageId ?? childTurnId;
  return {
    type: "assistant_message",
    text: update.content.text,
    ...(messageId ? { messageId } : {}),
  };
}

export class TraeACPAgentSession extends ACPAgentSession {
  protected override translateSessionNotification(params: SessionNotification): AgentStreamEvent[] {
    const childMeta = readTraeMeta(params._meta);
    if (childMeta?.type === "subagent_child") {
      return this.translateTraeChildUpdate(params, childMeta);
    }
    const rootEvents = super.translateSessionNotification(params);
    const spawnMeta = readTraeMeta(params.update._meta);
    if (
      spawnMeta?.type !== "subagent_control" ||
      spawnMeta.action !== "spawn_agent" ||
      params.update.sessionUpdate !== "tool_call" ||
      spawnMeta.parentThreadId !== params.sessionId ||
      typeof spawnMeta.childThreadId !== "string" ||
      !spawnMeta.childThreadId ||
      (spawnMeta.parentToolCallId !== undefined &&
        spawnMeta.parentToolCallId !== params.update.toolCallId)
    ) {
      return rootEvents;
    }
    return [
      ...rootEvents,
      this.subagentUpsert(spawnMeta.childThreadId, {
        toolCallId: params.update.toolCallId,
        description:
          typeof spawnMeta.agentNickname === "string" ? spawnMeta.agentNickname : undefined,
      }),
    ];
  }

  private translateTraeChildUpdate(
    params: SessionNotification,
    meta: Record<string, unknown>,
  ): AgentStreamEvent[] {
    if (
      meta.parentThreadId !== params.sessionId ||
      typeof meta.childThreadId !== "string" ||
      !meta.childThreadId ||
      typeof meta.parentToolCallId !== "string" ||
      !meta.parentToolCallId
    ) {
      return [];
    }
    const item = childTimelineItem(
      params.update,
      typeof meta.childTurnId === "string" ? meta.childTurnId : undefined,
    );
    if (!item) return [];

    const timeline: AgentStreamEvent = {
      type: "provider_subagent",
      provider: this.provider,
      event: { type: "timeline", id: meta.childThreadId, item },
    };
    return [
      this.subagentUpsert(meta.childThreadId, { toolCallId: meta.parentToolCallId }),
      timeline,
    ];
  }

  private subagentUpsert(
    id: string,
    fields: { toolCallId?: string; description?: string },
  ): AgentStreamEvent {
    return {
      type: "provider_subagent",
      provider: this.provider,
      event: {
        type: "upsert",
        id,
        ...fields,
      },
    };
  }
}
