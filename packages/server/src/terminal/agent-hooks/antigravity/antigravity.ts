import path from "node:path";
import type { AgentHookActivityState, AgentHookProvider } from "../agent-hook-installer.js";
import { type AntigravityHooksFile, antigravityHooksFormat } from "./antigravity-settings.js";

const ANTIGRAVITY_EVENT_STATES: Record<string, AgentHookActivityState> = {
  PreInvocation: "running",
  PostToolUse: "running",
  Stop: "idle",
};

export const antigravityAgentHookProvider: AgentHookProvider<AntigravityHooksFile> = {
  id: "antigravity",
  events: [{ event: "PreInvocation" }, { event: "PostToolUse" }, { event: "Stop" }],
  install: {
    kind: "config-file",
    configDir: path.join(".gemini", "config"),
    configFile: "hooks.json",
    configDirEnvOverride: "ANTIGRAVITY_CONFIG_DIR",
    hookMarker: "hooks antigravity",
    format: antigravityHooksFormat,
  },
  async resolveActivity({ event }) {
    return ANTIGRAVITY_EVENT_STATES[event] ?? null;
  },
};
