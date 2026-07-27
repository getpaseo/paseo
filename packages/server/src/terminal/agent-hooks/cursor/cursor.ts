import type { AgentHookActivityState, AgentHookProvider } from "../agent-hook-installer.js";
import { type CursorHooksFile, cursorHooksFormat } from "./cursor-settings.js";

const CURSOR_EVENT_STATES: Record<string, AgentHookActivityState> = {
  beforeSubmitPrompt: "running",
  preToolUse: "running",
  postToolUse: "running",
  stop: "idle",
  sessionEnd: "idle",
};

export const cursorAgentHookProvider: AgentHookProvider<CursorHooksFile> = {
  id: "cursor",
  events: [
    { event: "beforeSubmitPrompt" },
    { event: "preToolUse" },
    { event: "postToolUse" },
    { event: "stop" },
    { event: "sessionEnd" },
  ],
  install: {
    kind: "config-file",
    configDir: ".cursor",
    configFile: "hooks.json",
    configDirEnvOverride: "CURSOR_CONFIG_DIR",
    hookMarker: "hooks cursor",
    format: cursorHooksFormat,
  },
  async resolveActivity({ event }) {
    return CURSOR_EVENT_STATES[event] ?? null;
  },
};
