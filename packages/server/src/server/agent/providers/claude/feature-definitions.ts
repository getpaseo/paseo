import type { AgentOptionControl, AgentOptionToggleControl } from "../../agent-sdk-types.js";
import { claudeManifestModelSupportsFastMode } from "./model-manifest.js";

export const CLAUDE_FAST_MODE_CONTROL: AgentOptionToggleControl = {
  type: "toggle",
  key: "fast_mode",
  label: "Fast",
  description: "Lower latency Opus responses at higher token cost",
  tooltip: "Toggle fast mode",
  icon: "zap",
};

export function claudeModelSupportsFastMode(modelId: string | null | undefined): boolean {
  return claudeManifestModelSupportsFastMode(modelId);
}

export function buildClaudeControls(modelId: string | null | undefined): AgentOptionControl[] {
  return claudeModelSupportsFastMode(modelId) ? [{ ...CLAUDE_FAST_MODE_CONTROL }] : [];
}
