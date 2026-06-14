import type { AgentHookActivityState, AgentHookProvider } from "../agent-hook-installer.js";
import { type ClaudeSettings, claudeSettingsFormat } from "./claude-settings.js";

const CLAUDE_EVENT_STATES: Record<string, AgentHookActivityState> = {
  UserPromptSubmit: "running",
  Stop: "idle",
  StopFailure: "idle",
  SessionEnd: "idle",
};

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
      const raw = input.isTTY ? null : await input.read();
      return isIdlePrompt(raw) ? "needs-input" : null;
    }

    return CLAUDE_EVENT_STATES[event] ?? null;
  },
};

function isIdlePrompt(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const notification = JSON.parse(raw) as unknown;
    if (!notification || typeof notification !== "object") return false;
    const payload = notification as { matcher?: unknown; reason?: unknown };
    return payload.matcher === "idle_prompt" || payload.reason === "idle_prompt";
  } catch {
    return false;
  }
}
