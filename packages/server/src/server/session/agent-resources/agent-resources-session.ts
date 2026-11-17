import type pino from "pino";
import type {
  AgentResourceCapabilities,
  AgentResourcePolicy,
} from "@getpaseo/protocol/agent-resources";
import type { AgentResourcesDescription } from "../../agent/agent-manager.js";
import { getErrorMessageOr } from "@getpaseo/protocol/error-utils";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";

export interface AgentResourcesSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

/** The shell adapts these onto the AgentManager; tests wire an in-memory fake. */
export interface AgentResourcesOperations {
  capabilities(): Promise<AgentResourceCapabilities | null>;
  describe(agentId: string): Promise<AgentResourcesDescription>;
  set(agentId: string, resources: AgentResourcePolicy | null): Promise<void>;
}

export interface AgentResourcesSessionOptions {
  host: AgentResourcesSessionHost;
  operations: AgentResourcesOperations;
  logger: pino.Logger;
}

/** A client's view of per-agent resource controls: read what applies, replace the policy. */
export class AgentResourcesSession {
  private readonly host: AgentResourcesSessionHost;
  private readonly operations: AgentResourcesOperations;
  private readonly logger: pino.Logger;

  constructor(options: AgentResourcesSessionOptions) {
    this.host = options.host;
    this.operations = options.operations;
    this.logger = options.logger;
  }

  async handleGetRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.resources.get.request" }>,
  ): Promise<void> {
    const { requestId } = msg;
    const agentId = msg.agentId ?? null;
    try {
      const capabilities = await this.operations.capabilities();
      const description = agentId ? await this.operations.describe(agentId) : null;
      this.host.emit({
        type: "agent.resources.get.response",
        payload: {
          requestId,
          agentId,
          capabilities,
          resources: description?.resources ?? null,
          status: description?.status ?? null,
          error: null,
        },
      });
    } catch (error) {
      this.logger.error({ err: error, agentId, requestId }, "session: agent.resources.get error");
      this.host.emit({
        type: "agent.resources.get.response",
        payload: {
          requestId,
          agentId,
          capabilities: null,
          resources: null,
          status: null,
          error: getErrorMessageOr(error, "Failed to read agent resources"),
        },
      });
    }
  }

  async handleSetRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.resources.set.request" }>,
  ): Promise<void> {
    const { agentId, resources, requestId } = msg;
    this.logger.info({ agentId, requestId, resources }, "session: agent.resources.set");
    try {
      await this.operations.set(agentId, resources);
      const description = await this.operations.describe(agentId);
      this.host.emit({
        type: "agent.resources.set.response",
        payload: { requestId, agentId, accepted: true, error: null, ...description },
      });
    } catch (error) {
      this.logger.error({ err: error, agentId, requestId }, "session: agent.resources.set error");
      this.host.emit({
        type: "agent.resources.set.response",
        payload: {
          requestId,
          agentId,
          accepted: false,
          error: getErrorMessageOr(error, "Failed to set agent resources"),
          resources: null,
          status: null,
        },
      });
    }
  }
}
