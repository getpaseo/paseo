import type pino from "pino";
import { v4 as uuidv4 } from "uuid";
import { getErrorMessage, getErrorMessageOr } from "@getpaseo/protocol/error-utils";
import type { AgentProviderNotice } from "../../agent/agent-sdk-types.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";

/**
 * The four agent-config response messages share one payload shape; deriving the
 * type keeps it pinned to the protocol schema instead of restating it.
 */
type AgentActionResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "set_agent_mode_response" }
>["payload"];

export interface AgentConfigSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

/**
 * The per-agent config mutations this subsystem drives. The shell adapts these
 * onto the AgentManager and loads a collected agent before mutation (mode still
 * routes through setAgentModeCommand); tests wire an in-memory fake. Mode and
 * thinking yield a provider notice; model and feature do not.
 */
export interface AgentConfigOperations {
  ensureLoaded(agentId: string): Promise<void>;
  setMode(agentId: string, modeId: string): Promise<AgentProviderNotice | null>;
  setModel(agentId: string, modelId: string | null): Promise<void>;
  setFeature(agentId: string, featureId: string, value: unknown): Promise<void>;
  setThinking(
    agentId: string,
    thinkingOptionId: string | null,
  ): Promise<AgentProviderNotice | null>;
}

export interface AgentConfigSessionOptions {
  host: AgentConfigSessionHost;
  operations: AgentConfigOperations;
  logger: pino.Logger;
}

interface ConfigChange {
  agentId: string;
  requestId: string;
  logLabel: string;
  logFields: Record<string, unknown>;
  failureText: string;
  run: () => Promise<AgentProviderNotice | null | undefined>;
  emitResponse: (payload: AgentActionResponsePayload) => void;
}

/**
 * A client's per-agent config surface: set mode, model, feature, and thinking
 * option. Each request shares one envelope — log, run the mutation, then emit the
 * accepted response, or on failure emit an activity_log error frame followed by
 * the rejected response. Reaches no state beyond the injected operations and the
 * outbound channel.
 */
export class AgentConfigSession {
  private readonly host: AgentConfigSessionHost;
  private readonly operations: AgentConfigOperations;
  private readonly logger: pino.Logger;

  constructor(options: AgentConfigSessionOptions) {
    this.host = options.host;
    this.operations = options.operations;
    this.logger = options.logger;
  }

  handleSetAgentModeRequest(
    msg: Extract<SessionInboundMessage, { type: "set_agent_mode_request" }>,
  ): Promise<void> {
    const { agentId, modeId, requestId } = msg;
    return this.applyConfigChange({
      agentId,
      requestId,
      logLabel: "set_agent_mode_request",
      logFields: { agentId, modeId, requestId },
      failureText: "Failed to set agent mode",
      run: () => this.operations.setMode(agentId, modeId),
      emitResponse: (payload) => this.host.emit({ type: "set_agent_mode_response", payload }),
    });
  }

  handleSetAgentModelRequest(
    msg: Extract<SessionInboundMessage, { type: "set_agent_model_request" }>,
  ): Promise<void> {
    const { agentId, modelId, requestId } = msg;
    return this.applyConfigChange({
      agentId,
      requestId,
      logLabel: "set_agent_model_request",
      logFields: { agentId, modelId, requestId },
      failureText: "Failed to set agent model",
      run: async () => {
        await this.operations.setModel(agentId, modelId);
        return undefined;
      },
      emitResponse: (payload) => this.host.emit({ type: "set_agent_model_response", payload }),
    });
  }

  handleSetAgentFeatureRequest(
    msg: Extract<SessionInboundMessage, { type: "set_agent_feature_request" }>,
  ): Promise<void> {
    const { agentId, featureId, value, requestId } = msg;
    return this.applyConfigChange({
      agentId,
      requestId,
      logLabel: "set_agent_feature_request",
      logFields: { agentId, featureId, value, requestId },
      failureText: "Failed to set agent feature",
      run: async () => {
        await this.operations.setFeature(agentId, featureId, value);
        return undefined;
      },
      emitResponse: (payload) => this.host.emit({ type: "set_agent_feature_response", payload }),
    });
  }

  handleSetAgentThinkingRequest(
    msg: Extract<SessionInboundMessage, { type: "set_agent_thinking_request" }>,
  ): Promise<void> {
    const { agentId, thinkingOptionId, requestId } = msg;
    return this.applyConfigChange({
      agentId,
      requestId,
      logLabel: "set_agent_thinking_request",
      logFields: { agentId, thinkingOptionId, requestId },
      failureText: "Failed to set agent thinking option",
      run: () => this.operations.setThinking(agentId, thinkingOptionId),
      emitResponse: (payload) => this.host.emit({ type: "set_agent_thinking_response", payload }),
    });
  }

  private async applyConfigChange(change: ConfigChange): Promise<void> {
    const { agentId, requestId, logLabel, logFields, failureText, run, emitResponse } = change;
    this.logger.info(logFields, `session: ${logLabel}`);

    try {
      await this.operations.ensureLoaded(agentId);
      const notice = await run();
      this.logger.info(logFields, `session: ${logLabel} success`);
      emitResponse({ requestId, agentId, accepted: true, error: null, notice });
    } catch (error) {
      this.logger.error({ err: error, ...logFields }, `session: ${logLabel} error`);
      this.host.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `${failureText}: ${getErrorMessage(error)}`,
        },
      });
      emitResponse({
        requestId,
        agentId,
        accepted: false,
        error: getErrorMessageOr(error, failureText),
      });
    }
  }
}
