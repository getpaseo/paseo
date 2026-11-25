import type { SessionInfo, PermissionRuleset } from "@opencode/client";
import type { V2Api } from "./api.js";

import type { AgentOptionControl, AgentSessionConfig } from "../../../agent-sdk-types.js";

import { OpenCodeProviderOptionsSchema, buildOpenCodePermissionRules } from "../options.js";

import { modelRef } from "./mapping.js";
import { openCodeMcpToolName } from "./session-mcp.js";

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
    action: openCodeMcpToolName(grant.server, grant.tool),
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
export async function applyResumeOverrides(
  client: V2Api,
  info: SessionInfo,
  overrides?: Partial<AgentSessionConfig>,
) {
  if (overrides?.modeId) {
    await client.session.switchAgent({
      sessionID: info.id,
      agent: overrides.modeId,
    });
    info.agent = overrides.modeId;
  }
  if (overrides?.model || overrides?.thinkingOptionId !== undefined) {
    const model = overrides.model
      ? modelRef(overrides.model, overrides.thinkingOptionId ?? info.model?.variant)
      : info.model && { ...info.model, variant: overrides.thinkingOptionId };
    if (!model) throw new Error("Select an OpenCode model before changing its variant");
    await client.session.switchModel({ sessionID: info.id, model });
    info.model = model;
  }
}
