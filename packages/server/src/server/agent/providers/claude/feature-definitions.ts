import type { AgentOptionControl, AgentOptionToggleControl } from "../../agent-sdk-types.js";
import {
  claudeManifestModelSupportsFastMode,
  claudeManifestModelSupportsUltracode,
} from "./model-manifest.js";

export const CLAUDE_FAST_MODE_CONTROL: AgentOptionToggleControl = {
  type: "toggle",
  key: "fast_mode",
  label: "Fast",
  description: "Lower latency responses at higher token cost",
  tooltip: "Toggle fast mode",
  icon: "zap",
};

const CLAUDE_ULTRACODE_CONTROL: AgentOptionToggleControl = {
  type: "toggle",
  key: "ultracode",
  label: "Ultracode",
  description: "Let Claude plan workflows for substantive tasks",
  icon: "Workflow",
};

export function claudeModelSupportsFastMode(modelId: string | null | undefined): boolean {
  return claudeManifestModelSupportsFastMode(modelId);
}

export function buildClaudeControls(
  modelId: string | null | undefined,
  independentUltracode: boolean,
): AgentOptionControl[] {
  return [
    ...(claudeModelSupportsFastMode(modelId) ? [{ ...CLAUDE_FAST_MODE_CONTROL }] : []),
    ...(independentUltracode && claudeManifestModelSupportsUltracode(modelId)
      ? [{ ...CLAUDE_ULTRACODE_CONTROL }]
      : []),
  ];
}
