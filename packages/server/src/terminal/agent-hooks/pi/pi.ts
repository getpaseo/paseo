import type { AgentHookActivityState, AgentHookProvider } from "../agent-hook-installer.js";
import { createPiExtensionInstallStrategy } from "./pi-extension.js";

const PI_EVENT_STATES: Record<string, AgentHookActivityState> = {
  agent_start: "running",
  agent_settled: "idle",
  needs_input: "needs-input",
  resume: "running",
};

export const piAgentHookProvider: AgentHookProvider = {
  id: "pi",
  events: [
    { event: "agent_start" },
    { event: "agent_settled" },
    { event: "needs_input" },
    { event: "resume" },
  ],
  install: createPiExtensionInstallStrategy(),
  async resolveActivity({ event }) {
    return PI_EVENT_STATES[event] ?? null;
  },
};
