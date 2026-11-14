import type { SessionInfo, PermissionRuleset, ModelRef } from "@opencode/client";
import type { V2Api } from "./api.js";

import type {
  AgentLaunchContext,
  AgentOptionControl,
  AgentSessionConfig,
  AgentSessionConfigChange,
} from "../../../agent-sdk-types.js";

import { OpenCodeProviderOptionsSchema, buildOpenCodePermissionRules } from "../options.js";

import { modelRef } from "./mapping.js";

export const controls: AgentOptionControl[] = [
  { type: "toggle", key: "auto_accept", label: "Auto-accept" },
];
export function permissionRules(config: AgentSessionConfig): PermissionRuleset {
  const rules =
    buildOpenCodePermissionRules(
      OpenCodeProviderOptionsSchema.parse(config.providerOptions ?? {}),
      undefined,
    ) ?? [];
  const grants: PermissionRuleset = (config.toolPolicy?.preapproved ?? []).map((grant) => ({
    action: `${grant.server.replace(/[^a-zA-Z0-9_-]/g, "_")}_${grant.tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    resource: "*",
    effect: "allow",
  }));
  return [
    ...grants,
    ...rules.map((rule) => ({
      action: nativePermissionAction(rule.permission),
      resource: rule.pattern,
      effect: rule.action,
    })),
  ];
}
function nativePermissionAction(action: string): string {
  if (action === "bash") return "shell";
  if (action === "task") return "subagent";
  return action;
}
export async function reconcileSavedVariant({
  client,
  location,
  model,
}: {
  client: V2Api;
  location: { directory: string };
  model: ModelRef;
}): Promise<ModelRef> {
  if (!model.variant) return model;
  const catalog = await client.model.list({ location });
  const target = catalog.data.find(
    (entry) => entry.providerID === model.providerID && entry.id === model.id,
  );
  if (target && !target.variants.some((entry) => entry.id === model.variant)) {
    return { providerID: model.providerID, id: model.id };
  }
  return model;
}

export async function applyResumeOverrides({
  client,
  info,
  overrides = {},
  change,
}: {
  client: V2Api;
  info: SessionInfo;
  overrides?: Partial<AgentSessionConfig>;
  change?: AgentSessionConfigChange;
}) {
  if (overrides.modeId && change?.modeId === undefined) {
    await client.session.switchAgent({ sessionID: info.id, agent: overrides.modeId });
    info.agent = overrides.modeId;
  }
  if (change && "model" in change) return;
  const changingThinking = change && "thinkingOptionId" in change;
  if (overrides.model || (!changingThinking && overrides.thinkingOptionId !== undefined)) {
    const thinking = overrides.thinkingOptionId ?? info.model?.variant;
    let model = overrides.model
      ? modelRef(overrides.model, thinking)
      : info.model && { ...info.model, variant: thinking };
    if (!model) throw new Error("Select an OpenCode model before changing its variant");
    if (changingThinking)
      model = await reconcileSavedVariant({ client, location: info.location, model });
    await client.session.switchModel({ sessionID: info.id, model });
    info.model = model;
  }
}

// Agent identity env is applied per session through `session.environment`, so
// it must not force a dedicated server. Custom MCP is location-scoped, and any
// other env key belongs to the process, so both need isolation. Mirrors the v1
// adapter's `requiresDedicatedOpenCodeServer`.
const V2_SESSION_ENV_KEYS = new Set(["PASEO_AGENT_ID", "PASEO_AGENT_CWD", "PASEO_WORKSPACE_ID"]);

export function requiresDedicatedV2Server(
  config: AgentSessionConfig,
  launch?: AgentLaunchContext,
): boolean {
  if (Object.keys(config.mcpServers ?? {}).length > 0) return true;
  return Object.keys(launch?.env ?? {}).some((key) => !V2_SESSION_ENV_KEYS.has(key));
}
