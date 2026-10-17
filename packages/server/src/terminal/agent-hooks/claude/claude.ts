import type { AgentHookActivityState, AgentHookProvider } from "../agent-hook-installer.js";
import { readAgentHookPayload } from "../agent-hook-session.js";
import { type ClaudeSettings, claudeSettingsFormat } from "./claude-settings.js";

const CLAUDE_EVENT_STATES: Record<string, AgentHookActivityState> = {
  UserPromptSubmit: "running",
  Stop: "idle",
  StopFailure: "idle",
  SessionEnd: "idle",
};

const CLAUDE_QUIT_REASONS = new Set(["prompt_input_exit", "logout"]);

export const claudeAgentHookProvider: AgentHookProvider<ClaudeSettings> = {
  id: "claude",
  events: [
    { event: "UserPromptSubmit" },
    { event: "Stop" },
    { event: "StopFailure" },
    { event: "SessionEnd" },
    { event: "Notification" },
  ],
  install: {
    kind: "config-file",
    configDir: ".claude",
    configFile: "settings.json",
    configDirEnvOverride: "CLAUDE_CONFIG_DIR",
    hookMarker: "hooks claude",
    format: claudeSettingsFormat,
  },
  async resolveActivity({ event, input }) {
    if (event === "Notification") {
      const payload = await readAgentHookPayload(input);
      return payload?.fields.notification_type === "idle_prompt" ? "needs-input" : null;
    }

    return CLAUDE_EVENT_STATES[event] ?? null;
  },
  async resolveSession({ event, input }) {
    const payload = await readAgentHookPayload(input);
    if (!payload) return undefined;
    if (event === "SessionEnd") {
      // Only a deliberate quit ends the session. Signal-driven exits (`other`,
      // e.g. SIGHUP when the daemon stops) must stay resumable.
      return CLAUDE_QUIT_REASONS.has(String(payload.fields.reason)) ? null : undefined;
    }
    return payload.session ?? undefined;
  },
};
