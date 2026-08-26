import type { AgentHookActivityState, AgentHookProvider } from "../agent-hook-installer.js";
import { createOpenCodeV2PluginInstallStrategy } from "./opencode-v2-plugin.js";

const OPENCODE_V2_EVENT_STATES: Record<string, AgentHookActivityState> = {
  "session.status.busy": "running",
  "session.status.retry": "running",
  "session.status.idle": "idle",
  "permission.asked": "needs-input",
  "form.created": "needs-input",
  "permission.replied": "running",
  "form.replied": "running",
  "form.cancelled": "running",
};

export const opencodeV2AgentHookProvider: AgentHookProvider = {
  id: "opencode-v2",
  events: [
    { event: "session.status.busy" },
    { event: "session.status.retry" },
    { event: "session.status.idle" },
    { event: "permission.asked" },
    { event: "form.created" },
    { event: "permission.replied" },
    { event: "form.replied" },
    { event: "form.cancelled" },
  ],
  install: createOpenCodeV2PluginInstallStrategy(),
  async resolveActivity({ event }) {
    return OPENCODE_V2_EVENT_STATES[event] ?? null;
  },
};
