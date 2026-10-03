import type pino from "pino";
import { v4 as uuidv4 } from "uuid";
import { getErrorMessage, getErrorMessageOr } from "@getpaseo/protocol/error-utils";
import type { AgentConfigApply, AgentRoutingPolicy } from "@getpaseo/protocol/messages";
import type { AgentProviderNotice } from "../../agent/agent-sdk-types.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";

type AgentActionResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "set_agent_mode_response" }
>["payload"];

export interface AgentConfigSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface AgentConfigOperations {
  ensureLoaded(agentId: string): Promise<void>;
  setMode(agentId: string, modeId: string): Promise<AgentProviderNotice | null>;
  setModel(agentId: string, modelId: string | null): Promise<void>;
  setRoutingPolicy(agentId: string, policy: AgentRoutingPolicy | null): Promise<void>;
  setProvider(agentId: string, provider: string, modelId: string | null): Promise<void>;
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

  handleSetAgentRoutingPolicyRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.routing_policy.set.request" }>,
  ): Promise<void> {
    const { agentId, requestId, routingPolicy } = msg;
    return this.applyConfigChange({
      agentId,
      requestId,
      logLabel: "agent.routing_policy.set.request",
      logFields: { agentId, requestId },
      failureText: "Failed to set agent routing choices",
      run: async () => {
        await this.operations.setRoutingPolicy(agentId, routingPolicy);
        return undefined;
      },
      emitResponse: (payload) =>
        this.host.emit({ type: "agent.routing_policy.set.response", payload }),
    });
  }

  handleSetAgentProviderRequest(
    msg: Extract<SessionInboundMessage, { type: "set_agent_provider_request" }>,
  ): Promise<void> {
    const { agentId, provider, modelId, requestId } = msg;
    return this.applyConfigChange({
      agentId,
      requestId,
      logLabel: "set_agent_provider_request",
      logFields: { agentId, provider, modelId, requestId },
      failureText: "Failed to switch agent provider",
      run: async () => {
        await this.operations.setProvider(agentId, provider, modelId);
        return undefined;
      },
      emitResponse: (payload) => this.host.emit({ type: "set_agent_provider_response", payload }),
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

  handleAgentConfigApplyRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.config.apply.request" }>,
  ): Promise<void> {
    const { agentId, config, requestId } = msg;
    return this.applyConfigChange({
      agentId,
      requestId,
      logLabel: "agent.config.apply.request",
      logFields: { agentId, requestId, config },
      failureText: "Failed to apply agent config",
      run: () => this.applyBundle(agentId, config),
      emitResponse: (payload) => this.host.emit({ type: "agent.config.apply.response", payload }),
    });
  }

  private async applyBundle(
    agentId: string,
    config: AgentConfigApply,
  ): Promise<AgentProviderNotice | null> {
    let notice: AgentProviderNotice | null = null;

    if (config.modelId !== undefined) {
      await this.operations.setModel(agentId, config.modelId);
    }
    if (config.modeId !== undefined) {
      // Await first, assign second: `notice ??= await ...` would skip the call
      // entirely once an earlier step produced a notice.
      const modeNotice = await this.operations.setMode(agentId, config.modeId);
      notice ??= modeNotice;
    }
    if (config.thinkingOptionId !== undefined) {
      const thinkingNotice = await this.operations.setThinking(agentId, config.thinkingOptionId);
      notice ??= thinkingNotice;
    }
    for (const [featureId, value] of Object.entries(config.featureValues ?? {})) {
      await this.operations.setFeature(agentId, featureId, value);
    }

    return notice;
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
