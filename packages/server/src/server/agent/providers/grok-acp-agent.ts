// Grok does not publish ACP availableModes. Plan is a session/set_mode pair
// (plan|agent) plus a reverse x.ai/exit_plan_mode ext_method for approval.
// The composer surface matches Codex: a plan_mode toggle and a plan card.

import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type {
  AgentFeatureToggle,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentSessionConfig,
  AgentTimelineItem,
} from "../agent-sdk-types.js";
import type {
  ACPExtMethodContext,
  ACPFeatureWriterContext,
  ACPStaticToggleFeature,
} from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

export const GROK_PLAN_MODE_FEATURE_ID = "plan_mode";
export const GROK_PLAN_MODE_ID = "plan";
export const GROK_AGENT_MODE_ID = "agent";
export const GROK_EXIT_PLAN_MODE_METHOD = "x.ai/exit_plan_mode";

export const GROK_PLAN_MODE_FEATURE: ACPStaticToggleFeature = {
  id: GROK_PLAN_MODE_FEATURE_ID,
  label: "Plan",
  description: "Switch Grok into planning-only collaboration mode",
  tooltip: "Toggle plan mode",
  icon: "list-todo",
};

export interface GrokExitPlanModeRequest {
  sessionId: string;
  toolCallId: string;
  planContent: string | null;
}

export interface GrokExitPlanModeResponse {
  outcome: "approved" | "cancelled" | "abandoned";
  feedback?: string;
}

interface GrokACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

export function buildGrokPlanModeFeature(enabled: boolean): AgentFeatureToggle {
  return {
    ...GROK_PLAN_MODE_FEATURE,
    type: "toggle",
    value: enabled,
  };
}

function normalizeGrokExtMethod(method: string): string {
  return method.startsWith("_") ? method.slice(1) : method;
}

export function parseGrokExitPlanModeRequest(
  params: Record<string, unknown>,
): GrokExitPlanModeRequest {
  const sessionId = readOptionalString(params, ["sessionId", "session_id"]);
  const toolCallId = readOptionalString(params, ["toolCallId", "tool_call_id"]);
  if (!sessionId || !toolCallId) {
    throw new Error("Invalid exit_plan_mode params");
  }

  return {
    sessionId,
    toolCallId,
    planContent: readOptionalString(params, ["planContent", "plan_content"]),
  };
}

export function mapGrokPlanPermissionResponse(
  response: AgentPermissionResponse,
): GrokExitPlanModeResponse {
  if (response.behavior === "allow") {
    return { outcome: "approved" };
  }
  return { outcome: "cancelled" };
}

function buildGrokPlanPermissionRequest(params: {
  provider: string;
  planContent: string | null;
}): AgentPermissionRequest {
  const planText = params.planContent?.trim() ?? "";
  return {
    id: `grok-plan-${randomUUID()}`,
    provider: params.provider,
    name: "GrokPlanApproval",
    kind: "plan",
    title: "Plan",
    description: "Review the proposed plan before implementation starts.",
    input: { plan: planText },
    detail: planText
      ? {
          type: "plan",
          text: planText,
        }
      : undefined,
    actions: [
      {
        id: "dismiss",
        label: "Dismiss",
        behavior: "deny",
        variant: "danger",
        intent: "dismiss",
      },
      {
        id: "implement",
        label: "Implement",
        behavior: "allow",
        variant: "primary",
        intent: "implement",
      },
    ],
    metadata: {
      planText,
      source: "grok_plan_approval",
    },
  };
}

function buildGrokPlanTimelineItem(params: {
  toolCallId: string;
  planContent: string | null;
}): Extract<AgentTimelineItem, { type: "tool_call" }> | null {
  const text = params.planContent?.trim() ?? "";
  if (!text) {
    return null;
  }
  return {
    type: "tool_call",
    callId: params.toolCallId,
    name: "plan",
    status: "completed",
    error: null,
    detail: {
      type: "plan",
      text,
    },
  };
}

export async function writeGrokFeature(context: ACPFeatureWriterContext): Promise<boolean> {
  if (context.featureId !== GROK_PLAN_MODE_FEATURE_ID) {
    return false;
  }

  await context.connection.setSessionMode({
    sessionId: context.sessionId,
    modeId: context.value === true ? GROK_PLAN_MODE_ID : GROK_AGENT_MODE_ID,
  });
  return true;
}

export function syncGrokPlanModeFromCurrentMode(
  modeId: string | null,
  config: AgentSessionConfig,
): void {
  if (modeId !== GROK_PLAN_MODE_ID && modeId !== GROK_AGENT_MODE_ID) {
    return;
  }
  config.featureValues = {
    ...config.featureValues,
    [GROK_PLAN_MODE_FEATURE_ID]: modeId === GROK_PLAN_MODE_ID,
  };
}

export function transformGrokModeId(modeId: string): string | null {
  if (modeId === GROK_PLAN_MODE_ID || modeId === GROK_AGENT_MODE_ID) {
    return null;
  }
  return modeId;
}

export async function handleGrokExtMethod(
  method: string,
  params: Record<string, unknown>,
  context: ACPExtMethodContext,
): Promise<Record<string, unknown> | null> {
  if (normalizeGrokExtMethod(method) !== GROK_EXIT_PLAN_MODE_METHOD) {
    return null;
  }

  const request = parseGrokExitPlanModeRequest(params);
  if (context.sessionId && request.sessionId !== context.sessionId) {
    throw new Error("exit_plan_mode sessionId does not match the active session");
  }

  const permission = buildGrokPlanPermissionRequest({
    provider: context.provider,
    planContent: request.planContent,
  });
  const response = await context.requestPermission(permission, (resolved) => {
    applyGrokPlanApproval(resolved, request, context);
  });
  return { ...mapGrokPlanPermissionResponse(response) };
}

function applyGrokPlanApproval(
  response: AgentPermissionResponse,
  request: GrokExitPlanModeRequest,
  context: ACPExtMethodContext,
): void {
  if (response.behavior !== "allow") {
    return;
  }
  const timelineItem = buildGrokPlanTimelineItem({
    toolCallId: request.toolCallId,
    planContent: request.planContent,
  });
  if (timelineItem) {
    context.emitTimeline(timelineItem);
  }
  syncGrokPlanModeFromCurrentMode(GROK_AGENT_MODE_ID, context.config);
}

export class GrokACPAgentClient extends GenericACPAgentClient {
  constructor(options: GrokACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      staticToggleFeatures: [GROK_PLAN_MODE_FEATURE],
      featureWriter: writeGrokFeature,
      extMethodHandler: handleGrokExtMethod,
      currentModeListener: syncGrokPlanModeFromCurrentMode,
      modeIdTransformer: transformGrokModeId,
    });
  }
}

function readOptionalString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    if (value === null) {
      return null;
    }
  }
  return null;
}
