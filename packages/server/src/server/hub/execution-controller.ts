import { isAbsolute } from "node:path";
import type {
  HubExecutionAgentCreateRequest,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

import type { HubExecutionAgents, OwnedAgentEvent } from "./daemon-executions.js";

interface HubExecutionControllerOptions {
  agents: HubExecutionAgents;
  send: (message: SessionOutboundMessage) => void;
}

export class HubExecutionController {
  private readonly agents: HubExecutionAgents;
  private readonly send: (message: SessionOutboundMessage) => void;
  private readonly unsubscribe: () => void;
  private readonly pendingCreates = new Set<Promise<void>>();
  private cleanupPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: HubExecutionControllerOptions) {
    this.agents = options.agents;
    this.send = options.send;
    this.unsubscribe = this.agents.subscribe((event) => this.sendOwnedEvent(event));
  }

  cleanup(): Promise<void> {
    this.cleanupPromise ??= this.cleanupOnce();
    return this.cleanupPromise;
  }

  private async cleanupOnce(): Promise<void> {
    this.closed = true;
    this.unsubscribe();
    await Promise.allSettled(this.pendingCreates);
  }

  async createAgent(message: HubExecutionAgentCreateRequest): Promise<void> {
    if (this.closed) return;
    const create = this.createAgentWithResponse(message);
    this.pendingCreates.add(create);
    try {
      await create;
    } finally {
      this.pendingCreates.delete(create);
    }
  }

  private async createAgentWithResponse(message: HubExecutionAgentCreateRequest): Promise<void> {
    try {
      requireNonBlankHubAgentField("executionId", message.executionId);
      requireNonBlankHubAgentField("prompt", message.prompt);
      requireNonBlankHubAgentField("cwd", message.cwd);
      if (!isAbsolute(message.cwd)) throw new Error("Hub agent cwd must be absolute");
      const result = await this.agents.create({
        executionId: message.executionId,
        provider: message.provider,
        cwd: message.cwd,
        workspaceId: message.workspaceId,
        prompt: message.prompt,
        model: message.model,
        modeId: message.modeId,
        thinkingOptionId: message.thinkingOptionId,
        featureValues: message.featureValues,
        env: message.env,
        worktree: message.worktree,
        autoArchive: message.autoArchive,
      });
      if (this.closed) return;
      this.send({
        type: "hub.execution.agent.create.response",
        payload: {
          requestId: message.requestId,
          executionId: message.executionId,
          agentId: result.agent.id,
          agent: result.agent,
          success: true,
          error: null,
        },
      });
    } catch (error) {
      if (this.closed) return;
      this.send({
        type: "hub.execution.agent.create.response",
        payload: {
          requestId: message.requestId,
          executionId: message.executionId,
          agentId: null,
          agent: null,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private sendOwnedEvent(event: OwnedAgentEvent): void {
    if (this.closed) return;
    if (event.type === "update") {
      this.send({
        type: "hub.execution.agent.update",
        payload: {
          executionId: event.executionId,
          agentId: event.agent.id,
          agent: event.agent,
        },
      });
      return;
    }
    this.send({
      type: "hub.execution.agent.stream",
      payload: {
        executionId: event.executionId,
        agentId: event.agentId,
        event: event.event,
      },
    });
  }
}

function requireNonBlankHubAgentField(
  field: "executionId" | "prompt" | "cwd",
  value: string,
): void {
  if (value.trim().length === 0) {
    throw new Error(`Hub agent ${field} cannot be blank`);
  }
}
